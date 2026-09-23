import { createPublicClient, http, Chain, parseUnits } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../src/config';
import { AssetManager } from '../src/services/AssetManager';
import { OptimizedLiquidationService, UserReserveData } from '../src/services/OptimizedLiquidationService';

async function main() {
  console.log('\n======================================================');
  console.log(' QEMU ISOLATED TEST: Aave V3 Close Factor Calculation');
  console.log(' Feature 8: maxDebt = (HF > 0.95) ? debt * 0.5 : debt');
  console.log('======================================================\n');

  // Inisialisasi minimal RPC client & AssetManager
  const customChain: Chain = {
    ...basePreconf,
    rpcUrls: {
      ...basePreconf.rpcUrls,
      default: { http: [config.network.rpcUrl] },
    },
  } as Chain;

  const publicClient = createPublicClient({
    chain: customChain,
    transport: http(config.network.rpcUrl),
  });

  const assetManager = new AssetManager(publicClient, config.aave.protocolDataProvider);
  const liquidationService = new OptimizedLiquidationService(
    publicClient,
    config.aave.protocolDataProvider,
    assetManager
  );

  const WETH_ADDR = '0x4200000000000000000000000000000000000006';
  const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  // Setup mock harga
  const priceCache = new Map<string, number>();
  priceCache.set(WETH_ADDR, 3000); // WETH = $3000
  priceCache.set(USDC_ADDR, 1);    // USDC = $1.00

  let testsPassed = 0;
  let totalTests = 0;

  // -------------------------------------------------------------------------
  // SKENARIO 1: HF > 0.95 (HF = 0.98) -> Close factor 50%
  // -------------------------------------------------------------------------
  totalTests++;
  console.log('[Skenario 1] User HF = 0.98 (> 0.95) dengan Total Utang 1000 USDC...');
  const debtReserve1: UserReserveData = {
    asset: USDC_ADDR,
    symbol: 'USDC',
    decimals: 6,
    collateralBalance: 0n,
    debtBalance: parseUnits('1000', 6), // 1000 USDC
    usageAsCollateralEnabled: false,
    liquidationBonus: 0,
  };

  const collateralReserve1: UserReserveData = {
    asset: WETH_ADDR,
    symbol: 'WETH',
    decimals: 18,
    collateralBalance: parseUnits('1.0', 18), // 1 WETH = $3000 (sangat cukup)
    debtBalance: 0n,
    usageAsCollateralEnabled: true,
    liquidationBonus: 5, // 5% bonus
  };

  const params1 = liquidationService.prepareLiquidationParams(
    '0x1111111111111111111111111111111111111111',
    collateralReserve1,
    debtReserve1,
    priceCache,
    0.98
  );

  const expectedDebtCover1 = parseUnits('500', 6);
  if (params1 && params1.debtToCover === expectedDebtCover1) {
    console.log(`  PASSED: debtToCover = ${params1.debtToCover} (Tepat 50% dari total utang 1000 USDC)`);
    console.log(`  Nilai Estimasi USD: $${params1.estimatedValue.toFixed(2)} (Profit bonus: $${(params1.estimatedValue - params1.debtToCoverUSD).toFixed(2)})`);
    testsPassed++;
  } else {
    console.error(`  FAILED: Diharapkan ${expectedDebtCover1}, namun didapat ${params1?.debtToCover}`);
  }

  // -------------------------------------------------------------------------
  // SKENARIO 2: HF <= 0.95 (HF = 0.92) -> Close factor 100%
  // -------------------------------------------------------------------------
  totalTests++;
  console.log('\n[Skenario 2] User HF = 0.92 (<= 0.95) dengan Total Utang 1000 USDC...');
  const params2 = liquidationService.prepareLiquidationParams(
    '0x2222222222222222222222222222222222222222',
    collateralReserve1,
    debtReserve1,
    priceCache,
    0.92
  );

  const expectedDebtCover2 = parseUnits('1000', 6);
  if (params2 && params2.debtToCover === expectedDebtCover2) {
    console.log(`  PASSED: debtToCover = ${params2.debtToCover} (Tepat 100% dari total utang 1000 USDC)`);
    console.log(`  Nilai Estimasi USD: $${params2.estimatedValue.toFixed(2)}`);
    testsPassed++;
  } else {
    console.error(`  FAILED: Diharapkan ${expectedDebtCover2}, namun didapat ${params2?.debtToCover}`);
  }

  // -------------------------------------------------------------------------
  // SKENARIO 3: Kolateral Terbatas (Daya serap kolateral < 50% Utang)
  // -------------------------------------------------------------------------
  totalTests++;
  console.log('\n[Skenario 3] Kolateral Terbatas (0.05 WETH = $150, Utang 1000 USDC, HF = 0.98)...');
  const collateralReserveLow: UserReserveData = {
    asset: WETH_ADDR,
    symbol: 'WETH',
    decimals: 18,
    collateralBalance: parseUnits('0.05', 18), // 0.05 WETH * $3000 = $150
    debtBalance: 0n,
    usageAsCollateralEnabled: true,
    liquidationBonus: 5, // 5% bonus -> $150 / 1.05 = ~$142.85 max debt
  };

  const params3 = liquidationService.prepareLiquidationParams(
    '0x3333333333333333333333333333333333333333',
    collateralReserveLow,
    debtReserve1,
    priceCache,
    0.98
  );

  // Batas 50% adalah 500 USDC ($500), tapi kolateral hanya mampu menutup ~$142
  if (params3 && params3.debtToCover < expectedDebtCover1 && params3.debtToCoverUSD < 150) {
    console.log(`  PASSED: debtToCover dibatasi oleh daya serap kolateral: ${params3.debtToCover} ($${params3.debtToCoverUSD.toFixed(2)}) < $500`);
    testsPassed++;
  } else {
    console.error(`  FAILED: debtToCover tidak dibatasi secara tepat oleh kolateral: ${params3?.debtToCover}`);
  }

  // -------------------------------------------------------------------------
  // SKENARIO 4: Batas Tepat HF = 0.95 -> Harus Close Factor 100%
  // -------------------------------------------------------------------------
  totalTests++;
  console.log('\n[Skenario 4] Boundary Edge Case: User HF = 0.95 (Ambigu Threshold)...');
  const params4 = liquidationService.prepareLiquidationParams(
    '0x4444444444444444444444444444444444444444',
    collateralReserve1,
    debtReserve1,
    priceCache,
    0.95
  );

  // Berdasarkan aturan Aave V3: CLOSE_FACTOR_HF_THRESHOLD = 0.95e18. Jika HF <= 0.95 -> 100%
  if (params4 && params4.debtToCover === expectedDebtCover2) {
    console.log(`  PASSED: debtToCover = ${params4.debtToCover} (Pada HF = 0.95, protokol mengizinkan likuidasi 100%)`);
    testsPassed++;
  } else {
    console.error(`  FAILED: Pada HF = 0.95 diharapkan ${expectedDebtCover2}, didapat ${params4?.debtToCover}`);
  }

  console.log('\n======================================================');
  console.log(` KESIMPULAN HASIL UJI: ${testsPassed}/${totalTests} SKENARIO LULUS`);
  if (testsPassed === totalTests) {
    console.log(' STATUS: SEMPURNA (Sinkronisasi Close Factor Aave V3 Terverifikasi)');
  } else {
    console.log(' STATUS: GAGAL');
    process.exit(1);
  }
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
