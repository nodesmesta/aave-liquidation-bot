import * as dotenv from 'dotenv';
import { AaveV3Base } from '@bgd-labs/aave-address-book';

dotenv.config();

export const config = {
  // Network
  network: {
    rpcUrl: process.env.BASE_RPC_URL || '',
    wssUrl: process.env.BASE_WSS_URL || '',
    wssUrlFallback: process.env.BASE_WSS_URL_FALLBACK || '',
  },

  // Wallet
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
    mnemonic: process.env.MNEMONIC || '',
  },

  // Aave Contracts (dari Address Book)
  aave: {
    pool: AaveV3Base.POOL,
    poolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    oracle: AaveV3Base.ORACLE,
    protocolDataProvider: AaveV3Base.AAVE_PROTOCOL_DATA_PROVIDER,
    uiPoolDataProvider: AaveV3Base.UI_POOL_DATA_PROVIDER,
    subgraphUrl: process.env.AAVE_SUBGRAPH_URL || '',
  },

  // Liquidator Contract
  liquidator: {
    address: process.env.LIQUIDATOR_CONTRACT_ADDRESS || '',
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/liquidator.log',
  },

  // Rate Limiting & Batching
  rateLimit: {
    batchSize: parseInt(process.env.MULTICALL_BATCH_SIZE || '50'),
    batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '100'),
    maxConcurrentBatches: parseInt(process.env.MAX_CONCURRENT_BATCHES || '5'),
  },
};

// Asset configuration is now centralized in ./assets.ts
import { SupportedAsset } from './assets';

// Helper function to get asset symbol from address
export function getAssetSymbol(address: string): string {
  const normalizedAddress = address.toLowerCase();
  for (const [symbol, config] of Object.entries(SupportedAsset)) {
    if (config.address.toLowerCase() === normalizedAddress) {
      return symbol;
    }
  }
  return address;
}

// Validation
export function validateConfig(): void {
  if (!config.wallet.privateKey && !config.wallet.mnemonic) {
    throw new Error('Either PRIVATE_KEY or MNEMONIC must be set in environment');
  }
  
  if (!config.network.rpcUrl) {
    throw new Error('BASE_RPC_URL not set in environment');
  }
  
  if (!config.aave.subgraphUrl) {
    throw new Error('AAVE_SUBGRAPH_URL not set in environment. Get your API key from https://thegraph.com/studio/');
  }
}
