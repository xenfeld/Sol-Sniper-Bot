import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  Commitment,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { retry } from './utils';
import { retrieveEnvVariable, retrieveTokenValueByAddress } from './utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import pino from 'pino';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';

const logger = pino({
  level: 'info',
  base: undefined,
  transports: [
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
      },
    },
  ],
});

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);
const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

const commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let snipeList: string[] = [];

const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);

async function init(): Promise<void> {
  // Load wallet
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey.toBase58()}`);

  // Load quote token info
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);

  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}"`);
    }
  }

  // Get associated token address for quote token
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);
  const tokenAccount = tokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString()
  );

  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found for wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // Load snipe list if enabled
  if (USE_SNIPE_LIST) {
    loadSnipeList();
  }

  logger.info(`Initialized with ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
}

function loadSnipeList() {
  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data.split('\n').map((item) => item.trim()).filter(Boolean);
  if (snipeList.length !== count) {
    logger.info(`Loaded ${snipeList.length} tokens to snipe`);
  }
}

function shouldBuy(mint: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(mint) : true;
}

async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!shouldBuy(poolState.baseMint.toString())) return;

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintable = await checkMintable(poolState.baseMint);
    if (!mintable) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, mint is not renounced');
      return;
    }
  }

  await buy(id, poolState);
}

async function checkMintable(vault: PublicKey): Promise<boolean> {
  try {
    const { data } = await solanaConnection.getAccountInfo(vault);
    if (!data) return false;

    const decoded = MintLayout.decode(data);
    return decoded.mintAuthorityOption === 0;
  } catch (e) {
    logger.error({ vault }, `Failed to check mint authority`);
    return false;
  }
}

async function buy(accountId: PublicKey, poolState: LiquidityStateV4): Promise<void> {
  try {
    const tokenAccount = await saveTokenAccountIfNeeded(accountId, poolState);
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys!,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys!.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({ commitment });
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          tokenAccount.address,
          wallet.publicKey,
          poolState.baseMint,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([wallet, ...innerTransaction.signers]);

    const rawTransaction = transaction.serialize();
    const signature = await retry(() => solanaConnection.sendRawTransaction(rawTransaction), {
      retryIntervalMs: 10,
      retries: 50,
    });

    logger.info({ signature }, `Sent buy transaction`);
    const confirmation = await solanaConnection.confirmTransaction(
      { signature, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      commitment,
    );
    if (confirmation.value.err) {
      logger.error({ signature }, `Error confirming buy transaction`);
    } else {
      logger.info(`Successfully confirmed buy transaction`);
    }
  } catch (e) {
    logger.error(`Failed to buy token`, e);
  }
}

async function saveTokenAccountIfNeeded(accountId: PublicKey, poolState: LiquidityStateV4) {
  let tokenAccount = existingTokenAccounts.get(poolState.baseMint.toString());
  if (!tokenAccount) {
    const market = await getMinimalMarketV3(solanaConnection, poolState.marketId, commitment);
    tokenAccount = saveTokenAccount(poolState.baseMint, market);
  }
  tokenAccount.poolKeys = createPoolKeys(accountId, poolState, tokenAccount.market!);
  return tokenAccount;
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = {
    address: ata,
    mint,
    market: {
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(Date.now() / 1000);

  // Raydium liquidity pool listener
  solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      if (poolState.poolOpenTime.toNumber() > runTimestamp) {
        await processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  // OpenBook market listener
  solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
      if (!existingTokenAccounts.has(accountData.baseMint.toString())) {
        await saveTokenAccount(accountData.baseMint, accountData);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  // Auto sell functionality
  if (AUTO_SELL) {
    solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) return;
        let completed = false;
        while (!completed) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const currentValue = await retrieveTokenValueByAddress(accountData.mint.toBase58());
          if (currentValue) {
            logger.info(accountData.mint, `Current Price: ${currentValue} SOL`);
            completed = await sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, currentValue);
          }
        }
      },
      commitment,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );
  }
};

runListener();
