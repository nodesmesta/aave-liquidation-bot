import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { SmartRouter } from '../src/services/SmartRouter';
import { AssetManager } from '../src/services/AssetManager';
import { OptimizedLiquidationService } from '../src/services/OptimizedLiquidationService';
import { config } from '../src/config';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const assetManager = new AssetManager(client, config.aave.protocolDataProvider);
  await assetManager.initialize();

  const smartRouter = new SmartRouter(client);
  const liquidationService = new OptimizedLiquidationService(
    client,
    config.aave.protocolDataProvider,
    assetManager,
    smartRouter
  );

  const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
  const WEETH = '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  console.log('Testing prepareLiquidationParams for cbBTC (collateral) -> weETH (debt)...');
  const priceCache = new Map<string, number>();
  priceCache.set(CBBTC, 84300);
  priceCache.set(WEETH, 2670);

  const collateralReserve = {
    asset: CBBTC,
    symbol: 'cbBTC',
    decimals: 8,
    collateralBalance: 6101184n, // ~0.061 cbBTC
    debtBalance: 0n,
    usageAsCollateralEnabled: true,
    liquidationBonus: 5,
  };

  const debtReserve = {
    asset: WEETH,
    symbol: 'weETH',
    decimals: 18,
    collateralBalance: 0n,
    debtBalance: 10210807709226241n, // ~0.0102 weETH (~$27 USD)
    usageAsCollateralEnabled: false,
    liquidationBonus: 0,
  };

  const params = await liquidationService.prepareLiquidationParams(
    '0x7351102Eb34C69a9257fbc7e3e851d7d65aA14C8',
    collateralReserve,
    debtReserve,
    priceCache,
    0.98
  );

  console.log('\n--- Liquidation Params Result ---');
  console.log('User:            ', params?.userAddress);
  console.log('Collateral:      ', params?.collateralSymbol);
  console.log('Debt:            ', params?.debtSymbol);
  console.log('Debt to Cover:   ', params?.debtToCover.toString());
  console.log('Debt to Cover USD:', params?.debtToCoverUSD);
  console.log('SwapPath attached:', !!params?.swapPath);
  console.log('SwapPath hex:    ', params?.swapPath);

  if (params?.swapPath && params.swapPath.length > 2) {
    console.log('\n SUCCESS: SmartRouter attached dynamic swap path to LiquidationParams!');
  } else {
    console.error('\n FAILED: swapPath was not attached');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
