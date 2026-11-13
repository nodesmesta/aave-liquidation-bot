/**
 * @notice Differential parity test: our off-chain liquidation math vs Aave V3.4 on Base.
 * @dev The reference implementation below is a line-by-line port of
 *      `LiquidationLogic.executeLiquidationCall` + `_calculateAvailableCollateralToLiquidate`
 *      from aave-v3-origin (the version actually deployed on Base, verified on-chain:
 *      LiquidationLogic 0x96d5686812e33ab509eccdb38c89d15607b2a413 exposes
 *      MIN_LEFTOVER_BASE=1000e8, MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD=2000e8,
 *      CLOSE_FACTOR_HF_THRESHOLD=0.95e18).
 *
 *      The test feeds our `debtToCover` into the reference implementation and asserts that
 *      Aave would NOT revert. This is the property that matters: a wrong `debtToCover` is a
 *      wasted flashloan + gas, not just a bad estimate.
 *
 * Run: npx tsx test/test-aave-parity.ts
 */

import { OptimizedLiquidationService, UserReserveData } from '../src/services/OptimizedLiquidationService';
import { percentMul, percentDiv, AAVE } from '../src/config/thresholds';

// ---------------------------------------------------------------------------
// Reference implementation — exact Aave V3.4 semantics
// ---------------------------------------------------------------------------
const MIN_LEFTOVER_BASE = AAVE.MIN_LEFTOVER_BASE;
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = AAVE.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD;
const CLOSE_FACTOR_HF_THRESHOLD_RAW = AAVE.CLOSE_FACTOR_HF_THRESHOLD_RAW;

interface Position {
  collateralBalance: bigint;
  collateralDecimals: number;
  collateralPrice: bigint; // 8 decimals
  debtBalance: bigint;
  debtDecimals: number;
  debtPrice: bigint; // 8 decimals
  bonusBps: bigint;
  feeBps: bigint;
  hfRaw: bigint;
  totalDebtBase: bigint;
}

interface AaveOutcome {
  ok: boolean;
  reason: string;
  debtToCover: bigint;
  collateralToLiquidate: bigint;
  protocolFee: bigint;
}

/** Exact port of Aave V3.4 `executeLiquidationCall` liquidation math. */
function aaveReference(p: Position, requestedDebt: bigint): AaveOutcome {
  const cUnit = 10n ** BigInt(p.collateralDecimals);
  const dUnit = 10n ** BigInt(p.debtDecimals);

  const collateralBase = (p.collateralBalance * p.collateralPrice) / cUnit;
  const debtBase = (p.debtBalance * p.debtPrice) / dUnit;

  // --- close factor ---
  let maxLiquidatableDebt = p.debtBalance;
  if (
    collateralBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
    debtBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
    p.hfRaw > CLOSE_FACTOR_HF_THRESHOLD_RAW
  ) {
    const totalDefaultLiquidatable = percentMul(p.totalDebtBase, 5000n);
    if (debtBase > totalDefaultLiquidatable) {
      maxLiquidatableDebt = (totalDefaultLiquidatable * dUnit) / p.debtPrice;
    }
  }

  const actualDebtToLiquidate = requestedDebt > maxLiquidatableDebt ? maxLiquidatableDebt : requestedDebt;

  // --- _calculateAvailableCollateralToLiquidate ---
  const baseCollateral = (p.debtPrice * actualDebtToLiquidate * cUnit) / (p.collateralPrice * dUnit);
  const maxCollateralToLiquidate = percentMul(baseCollateral, p.bonusBps);

  let collateralAmount: bigint;
  let debtAmountNeeded: bigint;
  if (maxCollateralToLiquidate > p.collateralBalance) {
    collateralAmount = p.collateralBalance;
    debtAmountNeeded = percentDiv(
      (p.collateralPrice * collateralAmount * dUnit) / (p.debtPrice * cUnit),
      p.bonusBps
    );
  } else {
    collateralAmount = maxCollateralToLiquidate;
    debtAmountNeeded = actualDebtToLiquidate;
  }

  let protocolFee = 0n;
  if (p.feeBps !== 0n) {
    const bonusCollateral = collateralAmount - percentDiv(collateralAmount, p.bonusBps);
    protocolFee = percentMul(bonusCollateral, p.feeBps);
    collateralAmount -= protocolFee;
  }

  // --- MustNotLeaveDust ---
  if (debtAmountNeeded < p.debtBalance && collateralAmount + protocolFee < p.collateralBalance) {
    const debtLeftoverBase = ((p.debtBalance - debtAmountNeeded) * p.debtPrice) / dUnit;
    const collateralLeftoverBase =
      ((p.collateralBalance - collateralAmount - protocolFee) * p.collateralPrice) / cUnit;
    if (!(debtLeftoverBase >= MIN_LEFTOVER_BASE && collateralLeftoverBase >= MIN_LEFTOVER_BASE)) {
      return { ok: false, reason: 'MustNotLeaveDust', debtToCover: actualDebtToLiquidate, collateralToLiquidate: collateralAmount, protocolFee };
    }
  }

  return { ok: true, reason: '', debtToCover: actualDebtToLiquidate, collateralToLiquidate: collateralAmount, protocolFee };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASSED: ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const svc = new OptimizedLiquidationService(
  '0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad',
  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  null as any,
  null as any
);

const COLL = '0x4200000000000000000000000000000000000006';
const DEBT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function makeReserve(
  collateralBalance: bigint,
  collateralDecimals: number,
  debtBalance: bigint,
  debtDecimals: number,
  bonusBps: number,
  feeBps: number
): { collateral: UserReserveData; debt: UserReserveData } {
  return {
    collateral: {
      asset: COLL, symbol: 'COLL', decimals: collateralDecimals,
      collateralBalance, debtBalance: 0n, usageAsCollateralEnabled: true,
      liquidationBonus: (bonusBps - 10000) / 100,
      liquidationProtocolFee: feeBps / 100,
      liquidationBonusBps: bonusBps,
      liquidationProtocolFeeBps: feeBps,
    },
    debt: {
      asset: DEBT, symbol: 'DEBT', decimals: debtDecimals,
      collateralBalance: 0n, debtBalance, usageAsCollateralEnabled: false,
      liquidationBonus: 0, liquidationProtocolFee: 0,
    },
  };
}

async function main(): Promise<void> {
  console.log('======================================================');
  console.log(' Aave V3.4 parity test (Base)');
  console.log('======================================================');

  // -----------------------------------------------------------------------
  console.log('\n[P1] Rounding helpers match Aave PercentageMath (half-up)');
  // -----------------------------------------------------------------------
  const roundingCases: [bigint, bigint][] = [
    [333333333333333333n, 10500n],
    [999999999999999999n, 10250n],
    [1234567890123456789n, 10750n],
    [1n, 10500n],
    [1000000000000000001n, 11000n],
  ];
  let mulOk = true;
  let divOk = true;
  for (const [v, pct] of roundingCases) {
    // Aave assembly: div(add(mul(v, pct), 5000), 10000)
    if (percentMul(v, pct) !== (v * pct + 5000n) / 10000n) mulOk = false;
    // Aave assembly: div(add(mul(v, 10000), div(pct, 2)), pct)
    if (percentDiv(v, pct) !== (v * 10000n + pct / 2n) / pct) divOk = false;
  }
  check('percentMul rounds half-up like Aave', mulOk);
  check('percentDiv rounds half-up like Aave', divOk);

  // -----------------------------------------------------------------------
  console.log('\n[P2] MustNotLeaveDust: gross collateral vs net (the bug that was fixed)');
  // -----------------------------------------------------------------------
  // Collateral is almost exactly consumed by the bonus, so the protocol fee pushes the
  // GROSS amount above the balance. Aave then skips the dust guard entirely; using the NET
  // amount wrongly enters it and shrinks the liquidation.
  const p2 = makeReserve(679000000000000000000n, 18, 673000000n, 6, 10250, 2000);
  const priceCache2 = new Map<string, number>([
    [COLL, 3162],   // $3162
    [DEBT, 4979],   // $4979
  ]);
  const r2 = await svc.prepareLiquidationParams(
    '0x0000000000000000000000000000000000000001',
    p2.collateral, p2.debt, priceCache2, 940_000_000_000_000_000n, false, 335086700000000n
  );
  const ref2 = r2
    ? aaveReference({
        collateralBalance: 679000000000000000000n, collateralDecimals: 18, collateralPrice: 316200000000n,
        debtBalance: 673000000n, debtDecimals: 6, debtPrice: 497900000000n,
        bonusBps: 10250n, feeBps: 2000n, hfRaw: 940_000_000_000_000_000n,
        totalDebtBase: 335086700000000n,
      }, r2.debtToCover)
    : null;
  check('gross-collateral dust condition matches Aave', !!r2 && !!ref2 && ref2.ok,
    r2 ? `debtToCover=${r2.debtToCover}, aave=${ref2?.ok ? 'accepts' : ref2?.reason}` : 'no params');

  // -----------------------------------------------------------------------
  console.log('\n[P3] Randomized differential test (2000 positions)');
  // -----------------------------------------------------------------------
  let seed = 987654321;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (lo: bigint, hi: bigint): bigint => lo + BigInt(Math.floor(rnd() * Number(hi - lo)));

  let tested = 0;
  let skipped = 0;
  let reverts = 0;
  const revertSamples: string[] = [];

  for (let i = 0; i < 2000; i++) {
    const collDec = [8, 18][Math.floor(rnd() * 2)];
    const debtDec = [6, 8, 18][Math.floor(rnd() * 3)];
    const collPrice = ri(1n, 5000n) * 10n ** 8n;
    const debtPrice = ri(1n, 5000n) * 10n ** 8n;
    const collBal = ri(1n, 1000n) * 10n ** BigInt(collDec);
    const debtBal = ri(1n, 1000n) * 10n ** BigInt(debtDec);
    const bonusBps = [10250, 10500, 10750, 11000][Math.floor(rnd() * 4)];
    const feeBps = [0, 1000, 2000][Math.floor(rnd() * 3)];
    const hfRaw = ri(800n, 999n) * 10n ** 15n;
    const dUnit = 10n ** BigInt(debtDec);
    const totalDebtBase = (debtBal * debtPrice) / dUnit;

    const { collateral, debt } = makeReserve(collBal, collDec, debtBal, debtDec, bonusBps, feeBps);
    const priceCache = new Map<string, number>([
      [COLL, Number(collPrice) / 1e8],
      [DEBT, Number(debtPrice) / 1e8],
    ]);

    const params = await svc.prepareLiquidationParams(
      '0x0000000000000000000000000000000000000002',
      collateral, debt, priceCache, hfRaw, false, totalDebtBase
    );
    if (!params) { skipped++; continue; }
    tested++;

    const ref = aaveReference({
      collateralBalance: collBal, collateralDecimals: collDec, collateralPrice: collPrice,
      debtBalance: debtBal, debtDecimals: debtDec, debtPrice: debtPrice,
      bonusBps: BigInt(bonusBps), feeBps: BigInt(feeBps), hfRaw, totalDebtBase,
    }, params.debtToCover);

    if (!ref.ok) {
      reverts++;
      if (revertSamples.length < 3) {
        revertSamples.push(
          `coll=${collBal}/${collDec}d@${collPrice} debt=${debtBal}/${debtDec}d@${debtPrice} ` +
          `bonus=${bonusBps} fee=${feeBps} hf=${hfRaw} dtc=${params.debtToCover} -> ${ref.reason}`
        );
      }
    }
  }

  check('no Aave revert across randomized positions', reverts === 0,
    `tested=${tested} skipped=${skipped} reverts=${reverts}`);
  revertSamples.forEach((s) => console.log(`    ${s}`));

  // -----------------------------------------------------------------------
  console.log('\n[P4] Close factor boundary: HF exactly 0.95 must NOT cap');
  // -----------------------------------------------------------------------
  const big = makeReserve(1000n * 10n ** 18n, 18, 5000n * 10n ** 6n, 6, 10500, 1000);
  const priceCache4 = new Map<string, number>([[COLL, 3000], [DEBT, 1]]);
  const atBoundary = await svc.prepareLiquidationParams(
    '0x0000000000000000000000000000000000000003',
    big.collateral, big.debt, priceCache4, 950_000_000_000_000_000n, false, 5000n * 10n ** 8n
  );
  check('HF == 0.95 does not trigger the 50% cap',
    !!atBoundary && atBoundary.debtToCover === 5000n * 10n ** 6n,
    `debtToCover=${atBoundary?.debtToCover}`);

  const aboveBoundary = await svc.prepareLiquidationParams(
    '0x0000000000000000000000000000000000000004',
    big.collateral, big.debt, priceCache4, 950_000_000_000_000_001n, false, 5000n * 10n ** 8n
  );
  check('HF just above 0.95 triggers the 50% cap',
    !!aboveBoundary && aboveBoundary.debtToCover === 2500n * 10n ** 6n,
    `debtToCover=${aboveBoundary?.debtToCover}`);

  // -----------------------------------------------------------------------
  console.log('\n[P5] MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD gate');
  // -----------------------------------------------------------------------
  // Debt below $2000 => no cap even with HF > 0.95.
  const small = makeReserve(1000n * 10n ** 18n, 18, 1500n * 10n ** 6n, 6, 10500, 1000);
  const smallParams = await svc.prepareLiquidationParams(
    '0x0000000000000000000000000000000000000005',
    small.collateral, small.debt, priceCache4, 990_000_000_000_000_000n, false, 1500n * 10n ** 8n
  );
  check('debt < $2000 bypasses the 50% cap',
    !!smallParams && smallParams.debtToCover === 1500n * 10n ** 6n,
    `debtToCover=${smallParams?.debtToCover}`);

  console.log('\n======================================================');
  console.log(` RESULT: ${passed}/${passed + failed} checks passed`);
  if (failed === 0) {
    console.log(' STATUS: PASS (off-chain math matches Aave V3.4 on Base)');
  } else {
    console.log(' STATUS: FAIL');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('======================================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
