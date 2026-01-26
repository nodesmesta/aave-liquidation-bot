/**
 * Supported assets for liquidation bot on Base Aave V3
 * Synchronized with on-chain reserves
 * Priority: Higher = more liquid and preferred for liquidation
 */

export interface AssetConfig {
  symbol: string;
  address: string;
  decimals: number;
  priority: number;
  isCollateral: boolean;
  isDebt: boolean;
  monitorPrice: boolean;
}

export const SupportedAssets: Record<string, AssetConfig> = {
  WETH: {
    symbol: 'WETH',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    priority: 100,
    isCollateral: true,
    isDebt: true,
    monitorPrice: true,
  },
  cbBTC: {
    symbol: 'cbBTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    decimals: 8,
    priority: 95,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  tBTC: {
    symbol: 'tBTC',
    address: '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b',
    decimals: 18,
    priority: 95,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  LBTC: {
    symbol: 'LBTC',
    address: '0xecAc9C5F704e954931349Da37F60E39f515c11c1',
    decimals: 8,
    priority: 95,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  USDC: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    priority: 95,
    isCollateral: true,
    isDebt: true,
    monitorPrice: false,
  },
  USDbC: {
    symbol: 'USDbC',
    address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    decimals: 6,
    priority: 95,
    isCollateral: true,
    isDebt: true,
    monitorPrice: false,
  },
  cbETH: {
    symbol: 'cbETH',
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    decimals: 18,
    priority: 90,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  wstETH: {
    symbol: 'wstETH',
    address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    decimals: 18,
    priority: 90,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  weETH: {
    symbol: 'weETH',
    address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
    decimals: 18,
    priority: 90,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  ezETH: {
    symbol: 'ezETH',
    address: '0x2416092f143378750bb29b79eD961ab195CcEea5',
    decimals: 18,
    priority: 90,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  wrsETH: {
    symbol: 'wrsETH',
    address: '0xEDfa23602D0EC14714057867A78d01e94176BEA0',
    decimals: 18,
    priority: 90,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
  GHO: {
    symbol: 'GHO',
    address: '0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee',
    decimals: 18,
    priority: 80,
    isCollateral: false,
    isDebt: true,
    monitorPrice: false,
  },
  EURC: {
    symbol: 'EURC',
    address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    decimals: 6,
    priority: 75,
    isCollateral: true,
    isDebt: true,
    monitorPrice: false,
  },
  AAVE: {
    symbol: 'AAVE',
    address: '0x63706e401c06ac8513145b7687A14804d17f814b',
    decimals: 18,
    priority: 70,
    isCollateral: true,
    isDebt: false,
    monitorPrice: true,
  },
};

// Legacy export name (typo preserved for backward compatibility)
export const SupportedAsset = SupportedAssets;
