/**
 * @notice Centralized health-factor thresholds and Aave V3 liquidation constants.
 * @dev Two representations are kept on purpose:
 *      - `HF_RAW` (1e18-scaled bigint) MUST be used for every decision (liquidatable? tier? prune?).
 *        Comparing bigints avoids the float64 mantissa loss that made HF 0.999999999999999999
 *        round up to 1.0 and be treated as safe.
 *      - `HF` (decimal number) is for logging / display only.
 */

export const WAD = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Raw (1e18-scaled) health factor thresholds — use these for all decisions. */
export const HF_RAW = {
  /** HF < 1.0 => liquidatable */
  ONE: WAD,
  /** HF <= 1.03 => phase-1 priority bucket */
  HIGH_RISK: 1_030_000_000_000_000_000n,
  /** HF < 1.05 => critical */
  CRITICAL: 1_050_000_000_000_000_000n,
  /** HF < 1.075 => POOL tier */
  POOL_TIER: 1_075_000_000_000_000_000n,
  /** HF < 1.1 => warning */
  WARNING: 1_100_000_000_000_000_000n,
  /** HF >= 1.15 => prune (out of tracked range) */
  WATCH_MAX: 1_150_000_000_000_000_000n,
} as const;

/** Decimal thresholds — display / logging only. Never use for decisions. */
export const HF = {
  LIQUIDATABLE: 1.0,
  HIGH_RISK: 1.03,
  CRITICAL: 1.05,
  POOL_TIER: 1.075,
  WARNING: 1.1,
  WATCH_MAX: 1.15,
  PRUNE: 1.15,
  /** Subgraph pre-filter buffer. Raised from 1.15: subgraph `priceInEth` lags the on-chain
   *  oracle, so a fast crash can make an on-chain-HF-0.98 user look like 1.20 off-chain. */
  SUBGRAPH_PREFILTER: 1.5,
  /** Price-triggered re-check only runs for users whose worst-case HF can fall below this. */
  PRICE_TRIGGER: 1.1,
} as const;

/** Aave V3 liquidation constants (mirrors LiquidationLogic.sol). */
export const AAVE = {
  BASE_CURRENCY_DECIMALS: 8,
  /** Below (inclusive) this HF the full debt becomes liquidatable. */
  CLOSE_FACTOR_HF_THRESHOLD: 0.95,
  CLOSE_FACTOR_HF_THRESHOLD_RAW: 950_000_000_000_000_000n,
  /** 50% of total debt when the close-factor cap applies. */
  DEFAULT_LIQUIDATION_CLOSE_FACTOR: 0.5,
  /** 2000e8 — collateral & debt must both be >= this for the 50% cap to apply. */
  MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD: 200_000_000_000n,
  /** MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD / 2 = 1000e8 — MustNotLeaveDust floor. */
  MIN_LEFTOVER_BASE: 100_000_000_000n,
  /** Minimum estimated liquidation value to bother executing. */
  MIN_LIQUIDATION_VALUE_USD: 100,
  /** Minimum debt (USD) for a user to be worth tracking. */
  MIN_TRACKED_DEBT_USD: 100,
} as const;

/** Timing knobs for the detection pipeline. */
export const TIMING = {
  /** A tracked user whose HF has not been refreshed for this long is always re-checked. */
  MAX_HF_STALENESS_MS: 10 * 60 * 1000,
  /** Periodic sweep of the POOL tier, independent of price events. */
  POOL_SWEEP_INTERVAL_MS: 60 * 1000,
  /** Max users for which full liquidation params are computed per cycle. */
  MAX_PARAM_CANDIDATES: 5,
} as const;

/**
 * @notice Convert a raw 1e18 health factor to a display number.
 * @dev Truncates to 6 decimals instead of rounding. Rounding is what caused
 *      0.999999999999999999 to display (and compare) as 1.0. Truncation keeps every
 *      "less than" comparison correct: a value below a threshold can never be pushed above it.
 * @param hfRaw Raw health factor (1e18). `type(uint256).max` means "no debt".
 * @return Health factor as a number, or Infinity when the user has no debt.
 */
export function hfRawToNumber(hfRaw: bigint): number {
  if (hfRaw >= MAX_UINT256) return Infinity;
  // 1e18 -> 1e6 keeps 6 decimals of precision and stays inside float64's exact integer range.
  return Number(hfRaw / 10n ** 12n) / 1e6;
}

/** @notice HF < 1.0 (raw comparison, no float involved). */
export function isLiquidatableRaw(hfRaw: bigint): boolean {
  return hfRaw < HF_RAW.ONE;
}

/** @notice HF < 1.075 => POOL tier. */
export function isPoolTierRaw(hfRaw: bigint): boolean {
  return hfRaw < HF_RAW.POOL_TIER;
}

/** @notice HF >= 1.15 => out of tracked range. */
export function shouldPruneRaw(hfRaw: bigint): boolean {
  return hfRaw >= HF_RAW.WATCH_MAX;
}

/**
 * @notice Aave `PercentageMath.percentMul` — multiplies by a bps percentage, rounding HALF-UP.
 * @dev Aave's assembly is `div(add(mul(value, percentage), HALF_PERCENTAGE_FACTOR), PERCENTAGE_FACTOR)`.
 *      Plain `(value * pct) / 1e4` truncates and drifts by 1 wei, which is enough to make the
 *      on-chain `MustNotLeaveDust` check disagree with our off-chain prediction.
 */
export function percentMul(value: bigint, percentage: bigint): bigint {
  return (value * percentage + 5000n) / 10000n;
}

/** @notice Aave `PercentageMath.percentDiv` — divides by a bps percentage, rounding HALF-UP. */
export function percentDiv(value: bigint, percentage: bigint): bigint {
  return (value * 10000n + percentage / 2n) / percentage;
}

/** @notice Format a raw HF for logs. */
export function formatHF(hfRaw: bigint): string {
  const n = hfRawToNumber(hfRaw);
  if (!Number.isFinite(n)) return '∞';
  // Truncate instead of rounding: `toFixed` would render 0.999999 as "1.0000", which reads as
  // safe in the logs even though the position is liquidatable.
  const scaled = Math.floor(n * 1e6);
  const whole = Math.floor(scaled / 1e6);
  const frac = String(scaled % 1e6).padStart(6, '0');
  return `${whole}.${frac}`;
}
