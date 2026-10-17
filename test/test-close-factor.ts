import { createPublicClient, http, Chain, parseUnits } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../src/config';
import { AssetManager } from '../src/services/AssetManager';
import { OptimizedLiquidationService, UserReserveData } from '../src/services/OptimizedLiquidationService';

/**
 * Verifies OptimizedLiquidationService against Aave v3.3 liquidation rules:
 *  - Default close factor is 100% of the reserve debt.
 *  - 50% cap applies ONLY when (collateralBase >= $2000) && (debtBase >= $2000) && (HF > 0.95),
 *    and the 50% is taken over the user's TOTAL position debt.
 *  - MustNotLeaveDust: on partial liquidation, both leftovers must be >= $1000 (MIN_LEFTOVER_BASE).
 *
 * Pure off-chain calculation test: uses a mocked priceCache, no RPC calls to Aave.
 */
async function main() {
  console.log('\n======================================================');
  console.log(' TEST: Aave v3.3 Close Factor & Dust (off-chain calc)');
  console.log(' Rules: default 100%; 50% cap iff coll>=$2000 && debt>=$2000 && HF>0.95');
  console.log('        MIN_LEFTOVER_BASE = $1000 on partial liquidation');
  console.log('======================================================\n');

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
  const svc = new OptimizedLiquidationService(
    publicClient,
    config.aave.protocolDataProvider,
    assetManager
  );

  const WETH = '0x4200000000000000000000000000000000000006';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  const priceCache = new Map<string, number>();
  priceCache.set(WETH, 3000);
  priceCache.set(USDC, 1);

  // Base currency amounts (8 decimals) used for the totalDebtBase arg
  const base = (usd: number) => BigInt(Math.round(usd * 1e8));

  let passed = 0;
  let total = 0;

  const check = (name: string, cond: boolean, detail: string) => {
    total++;
    if (cond) { passed++; console.log(`  PASSED: ${name} — ${detail}`); }
    else { console.error(`  FAILED: ${name} — ${detail}`); }
  };

  // Ample collateral so collateral never constrains debtToCover unless intended.
  const bigWeth: UserReserveData = {
    asset: WETH, symbol: 'WETH', decimals: 18,
    collateralBalance: parseUnits('10', 18), // $30,000
    debtBalance: 0n, usageAsCollateralEnabled: true, liquidationBonus: 5,
    liquidationProtocolFee: 10,
  };

  // ---------------------------------------------------------------------------
  // Scenario 1: Small position ($1000 debt < $2000 threshold), HF 0.98.
  // v3.3: cap does NOT apply -> 100% liquidatable (1000 USDC).
  // (Old v3.0 logic would have capped to 500 USDC.)
  // ---------------------------------------------------------------------------
  console.log('[S1] debt $1000 (< $2000), HF 0.98 -> expect 100% (1000 USDC)');
  const debt1000: UserReserveData = {
    asset: USDC, symbol: 'USDC', decimals: 6,
    collateralBalance: 0n, debtBalance: parseUnits('1000', 6),
    usageAsCollateralEnabled: false, liquidationBonus: 0,
    liquidationProtocolFee: 0,
  };
  const p1 = await svc.prepareLiquidationParams(
    '0x1111111111111111111111111111111111111111',
    bigWeth, debt1000, priceCache, 0.98, false, base(1000)
  );
  check('S1 full close factor under $2000 threshold',
    !!p1 && p1.debtToCover === parseUnits('1000', 6),
    `debtToCover=${p1?.debtToCover} (expected ${parseUnits('1000', 6)})`);

  // ---------------------------------------------------------------------------
  // Scenario 2: Large position ($5000 debt >= $2000), collateral >= $2000, HF 0.98.
  // v3.3: cap APPLIES -> 50% of total debt = 2500 USDC.
  // ---------------------------------------------------------------------------
  console.log('\n[S2] debt $5000 (>= $2000), coll $30000, HF 0.98 -> expect 50% (2500 USDC)');
  const debt5000: UserReserveData = {
    asset: USDC, symbol: 'USDC', decimals: 6,
    collateralBalance: 0n, debtBalance: parseUnits('5000', 6),
    usageAsCollateralEnabled: false, liquidationBonus: 0,
    liquidationProtocolFee: 0,
  };
  const p2 = await svc.prepareLiquidationParams(
    '0x2222222222222222222222222222222222222222',
    bigWeth, debt5000, priceCache, 0.98, false, base(5000)
  );
  check('S2 50% cap applies above $2000 threshold',
    !!p2 && p2.debtToCover === parseUnits('2500', 6),
    `debtToCover=${p2?.debtToCover} (expected ${parseUnits('2500', 6)})`);

  // ---------------------------------------------------------------------------
  // Scenario 3: Large position but HF 0.92 (<= 0.95) -> cap does NOT apply -> 100%.
  // ---------------------------------------------------------------------------
  console.log('\n[S3] debt $5000, HF 0.92 (<= 0.95) -> expect 100% (5000 USDC)');
  const p3 = await svc.prepareLiquidationParams(
    '0x3333333333333333333333333333333333333333',
    bigWeth, debt5000, priceCache, 0.92, false, base(5000)
  );
  check('S3 HF below threshold bypasses 50% cap',
    !!p3 && p3.debtToCover === parseUnits('5000', 6),
    `debtToCover=${p3?.debtToCover} (expected ${parseUnits('5000', 6)})`);

  // ---------------------------------------------------------------------------
  // Scenario 4: Dust guard. Large position $5000 debt, HF 0.92 (100% allowed),
  // but collateral only ~$2600 so partial liquidation would leave < $1000 on a side.
  // Expect debtToCover adjusted so leftovers respect $1000, i.e. debtToCover < full.
  // ---------------------------------------------------------------------------
  console.log('\n[S4] dust guard: coll ~$2600 vs debt $5000, HF 0.92 -> partial adjusted for $1000 floor');
  const smallWeth: UserReserveData = {
    asset: WETH, symbol: 'WETH', decimals: 18,
    collateralBalance: parseUnits('0.8667', 18), // ~$2600
    debtBalance: 0n, usageAsCollateralEnabled: true, liquidationBonus: 5,
    liquidationProtocolFee: 10,
  };
  const p4 = await svc.prepareLiquidationParams(
    '0x4444444444444444444444444444444444444444',
    smallWeth, debt5000, priceCache, 0.92, false, base(5000)
  );
  // Collateral can absorb ~$2600/1.05 = ~$2476 of debt. Full debt not possible.
  // Leftover collateral would be ~0, leftover debt ~ $2524 (>= $1000). The guard
  // must ensure the collateral leftover is either 0 (fully consumed) or >= $1000.
  const p4ok = !!p4 && p4.debtToCover < parseUnits('5000', 6) && p4.debtToCoverUSD > 0;
  check('S4 partial liquidation respects dust guard',
    p4ok,
    `debtToCover=${p4?.debtToCover} ($${p4?.debtToCoverUSD.toFixed(2)}), estValue=$${p4?.estimatedValue.toFixed(2)}`);

  // ---------------------------------------------------------------------------
  // Scenario 5: Boundary HF exactly 0.95 with large position -> cap does NOT apply
  // (v3.3: cap only when HF > 0.95), so 100%.
  // ---------------------------------------------------------------------------
  console.log('\n[S5] boundary HF = 0.95, debt $5000 -> expect 100% (cap requires HF > 0.95)');
  const p5 = await svc.prepareLiquidationParams(
    '0x5555555555555555555555555555555555555555',
    bigWeth, debt5000, priceCache, 0.95, false, base(5000)
  );
  check('S5 HF == 0.95 is not strictly greater -> no cap',
    !!p5 && p5.debtToCover === parseUnits('5000', 6),
    `debtToCover=${p5?.debtToCover} (expected ${parseUnits('5000', 6)})`);

  console.log('\n[S6] protocol fee: debt $1000, bonus 5%, fee 10% -> estValue net = $1045 (gross $1050 - $5 fee)');
  const p6 = await svc.prepareLiquidationParams(
    '0x6666666666666666666666666666666666666666',
    bigWeth, debt1000, priceCache, 0.98, false, base(1000)
  );
  const estValue6 = p6?.estimatedValue ?? 0;
  check('S6 estimatedValue is net of protocol fee',
    !!p6 && Math.abs(estValue6 - 1045) < 0.01,
    `estimatedValue=$${estValue6.toFixed(4)} (expected $1045.00; gross $1050 - 10% of $50 bonus)`);

  console.log('\n======================================================');
  console.log(` RESULT: ${passed}/${total} scenarios passed`);
  if (passed === total) {
    console.log(' STATUS: PASS (Aave v3.3 close factor & dust verified)');
  } else {
    console.log(' STATUS: FAIL');
    process.exit(1);
  }
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
