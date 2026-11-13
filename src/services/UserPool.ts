import { logger } from '../utils/logger';
import { HF_RAW, hfRawToNumber, isPoolTierRaw, shouldPruneRaw } from '../config/thresholds';

export type UserTier = 'POOL' | 'WATCH';

/**
 * @notice Input accepted by `UserPool.addUser`
 * @dev Derived fields are optional so callers that only know the decimal HF (tests, snapshot
 *      restore) still work; `addUser` fills them in.
 */
export interface TrackedUserInput {
  address: string;
  tier?: UserTier;
  collateralAssets: string[];
  debtAssets: string[];
  collateralUSD: number;
  debtUSD: number;
  collateralUSDByAsset?: Record<string, number>;
  debtUSDByAsset?: Record<string, number>;
  liquidationThresholdRatio?: number;
  estimatedHF: number;
  lastCheckedHFRaw?: bigint;
  lastCheckedHF?: number;
  lastUpdated?: number;
  addedAt?: number;
}

export interface TrackedUser {
  address: string;
  /**
   * POOL  = HF < 1.075, kandidat likuidasi utama
   * WATCH = 1.075 <= HF < 1.15, tetap tersimpan dan ikut ter-sweep saat harga bergerak
   */
  tier: UserTier;
  collateralAssets: string[];
  debtAssets: string[];
  collateralUSD: number;
  debtUSD: number;
  /** Per-asset USD value of collateral, keyed by lowercase asset address. Enables exact local
   *  health-factor estimation on a price move without any RPC call. */
  collateralUSDByAsset: Record<string, number>;
  /** Per-asset USD value of debt, keyed by lowercase asset address. */
  debtUSDByAsset: Record<string, number>;
  /**
   * Average liquidation threshold as a fraction (e.g. 0.825), derived from the last on-chain read:
   * HF = collateralUSD * ratio / debtUSD. Price-independent, so it stays valid as prices move.
   */
  liquidationThresholdRatio: number;
  estimatedHF: number;
  /** Raw 1e18 health factor from the last on-chain read. Decisions use this, never the float. */
  lastCheckedHFRaw: bigint;
  /** Display-only decimal mirror of `lastCheckedHFRaw`. */
  lastCheckedHF: number;
  lastUpdated: number;
  addedAt: number;
}

export class UserPool {
  private users: Map<string, TrackedUser>;
  /** asset address -> set of user addresses holding it as collateral (O(1) price-event lookup). */
  private collateralIndex: Map<string, Set<string>> = new Map();
  /** asset address -> set of user addresses holding it as debt. */
  private debtIndex: Map<string, Set<string>> = new Map();

  constructor() {
    this.users = new Map();
  }

  /**
   * @notice Add a user to the tracking pool
   * @dev Normalizes address to lowercase, keeps the original addedAt on re-add, and fills in the
   *      derived fields (raw HF, per-asset breakdown, threshold ratio) so callers that only know
   *      the decimal HF still produce a consistent record.
   * @param user User data to track
   */
  addUser(user: TrackedUserInput): void {
    const address = user.address.toLowerCase();
    const existing = this.users.get(address);
    if (existing) {
      this.unindexAssets(address, existing);
    }
    const lastCheckedHFRaw = user.lastCheckedHFRaw
      ?? BigInt(Math.round((user.lastCheckedHF ?? user.estimatedHF ?? 1.2) * 1e18));
    const next: TrackedUser = {
      ...user,
      address,
      tier: user.tier || 'POOL',
      collateralUSDByAsset: user.collateralUSDByAsset ?? {},
      debtUSDByAsset: user.debtUSDByAsset ?? {},
      liquidationThresholdRatio: user.liquidationThresholdRatio ?? 0,
      lastCheckedHFRaw,
      lastCheckedHF: user.lastCheckedHF ?? hfRawToNumber(lastCheckedHFRaw),
      addedAt: existing?.addedAt || user.addedAt || Date.now(),
      lastUpdated: Date.now(),
    };
    this.users.set(address, next);
    this.indexAssets(address, next);
  }

  /** @notice Add a user's assets to the reverse indexes. */
  private indexAssets(address: string, user: TrackedUser): void {
    for (const asset of user.collateralAssets) {
      const key = asset.toLowerCase();
      let set = this.collateralIndex.get(key);
      if (!set) {
        set = new Set();
        this.collateralIndex.set(key, set);
      }
      set.add(address);
    }
    for (const asset of user.debtAssets) {
      const key = asset.toLowerCase();
      let set = this.debtIndex.get(key);
      if (!set) {
        set = new Set();
        this.debtIndex.set(key, set);
      }
      set.add(address);
    }
  }

  /** @notice Remove a user's assets from the reverse indexes. */
  private unindexAssets(address: string, user: TrackedUser): void {
    for (const asset of user.collateralAssets) {
      const key = asset.toLowerCase();
      const set = this.collateralIndex.get(key);
      if (set) {
        set.delete(address);
        if (set.size === 0) this.collateralIndex.delete(key);
      }
    }
    for (const asset of user.debtAssets) {
      const key = asset.toLowerCase();
      const set = this.debtIndex.get(key);
      if (set) {
        set.delete(address);
        if (set.size === 0) this.debtIndex.delete(key);
      }
    }
  }

  /**
   * @notice Get a single tracked user
   * @param address User address
   */
  getUser(address: string): TrackedUser | undefined {
    return this.users.get(address.toLowerCase());
  }

  /**
   * @notice Move a user between POOL and WATCH tiers
   * @param address User address
   * @param tier Target tier
   * @return True if the user exists and was updated
   */
  setTier(address: string, tier: UserTier): boolean {
    const user = this.users.get(address.toLowerCase());
    if (!user) return false;
    if (user.tier !== tier) {
      user.tier = tier;
      user.lastUpdated = Date.now();
    }
    return true;
  }

  /**
   * @notice Refresh a user's asset composition without an on-chain call
   * @dev Sourced from the subgraph candidate list; only touches the fields that changed
   * @param address User address
   * @param assets Collateral and debt asset addresses
   */
  updateUserAssets(address: string, assets: { collateralAssets: string[]; debtAssets: string[] }): boolean {
    const user = this.users.get(address.toLowerCase());
    if (!user) return false;
    const nextCollateral = assets.collateralAssets.map(a => a.toLowerCase());
    const nextDebt = assets.debtAssets.map(a => a.toLowerCase());
    const changed =
      nextCollateral.length !== user.collateralAssets.length ||
      nextDebt.length !== user.debtAssets.length ||
      nextCollateral.some((a, i) => a !== user.collateralAssets[i]) ||
      nextDebt.some((a, i) => a !== user.debtAssets[i]);
    if (changed) {
      this.unindexAssets(user.address, user);
      user.collateralAssets = nextCollateral;
      user.debtAssets = nextDebt;
      user.lastUpdated = Date.now();
      this.indexAssets(user.address, user);
    }
    return changed;
  }

  /**
   * @notice Remove a user from the tracking pool
   * @dev Logs removal action
   * @param address User address to remove
   * @return True if user was removed, false if not found
   */
  removeUser(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const existing = this.users.get(normalizedAddress);
    if (existing) {
      this.unindexAssets(normalizedAddress, existing);
    }
    const removed = this.users.delete(normalizedAddress);
    if (removed) {
      logger.info(`Removed user ${normalizedAddress} from pool`);
    }
    return removed;
  }

  /**
   * @notice Get all users in the pool
   * @dev Returns array of all tracked users
   * @return Array of tracked users
   */
  getAllUsers(): TrackedUser[] {
    return Array.from(this.users.values());
  }

  /**
   * @notice Get users that have a specific asset in their collateral
   * @dev Monitors collateral price drops (reduces HF)
   * @param assetAddress Asset contract address to filter by
   * @return Array of users with specified collateral
   */
  getUsersWithCollateral(assetAddress: string): TrackedUser[] {
    const set = this.collateralIndex.get(assetAddress.toLowerCase());
    if (!set) return [];
    const result: TrackedUser[] = [];
    for (const address of set) {
      const user = this.users.get(address);
      if (user) result.push(user);
    }
    return result;
  }

  /**
   * @notice Get users that have a specific asset in their debt
   * @dev Monitors debt price rises (reduces HF)
   * @param assetAddress Asset contract address to filter by
   * @return Array of users with specified debt
   */
  getUsersWithDebt(assetAddress: string): TrackedUser[] {
    const set = this.debtIndex.get(assetAddress.toLowerCase());
    if (!set) return [];
    const result: TrackedUser[] = [];
    for (const address of set) {
      const user = this.users.get(address);
      if (user) result.push(user);
    }
    return result;
  }

  /**
   * @notice Get unique collateral asset addresses across all tracked users
   * @dev Used for dynamic price monitoring - only subscribe to assets that users actually have
   * @return Array of unique collateral asset addresses
   */
  getUniqueCollateralAssets(): string[] {
    const uniqueAssets = new Set<string>();
    for (const user of this.getAllUsers()) {
      user.collateralAssets.forEach(asset => uniqueAssets.add(asset.toLowerCase()));
    }
    return Array.from(uniqueAssets);
  }

  /**
   * @notice Get unique debt asset addresses across all tracked users
   * @dev Used for price monitoring - debt price increases reduce HF
   * @return Array of unique debt asset addresses
   */
  getUniqueDebtAssets(): string[] {
    const uniqueAssets = new Set<string>();
    for (const user of this.getAllUsers()) {
      user.debtAssets.forEach(asset => uniqueAssets.add(asset.toLowerCase()));
    }
    return Array.from(uniqueAssets);
  }

  /**
   * @notice Estimate the health factor after a price move, without any RPC call
   * @dev Uses the per-asset USD breakdown captured at the last on-chain read plus the stored
   *      liquidation-threshold ratio. Both are price-independent, so the estimate stays consistent
   *      with Aave's own formula (HF = collateral * threshold / debt) as prices move.
   *      Returns `null` when the user has no debt or no breakdown, in which case the caller must
   *      fall back to an on-chain read.
   * @param address User address
   * @param priceChanges Map of lowercase asset address -> price multiplier (newPrice / oldPrice)
   * @return Estimated raw health factor, or null when it cannot be computed
   */
  estimateHFAfterPriceChange(address: string, priceChanges: Map<string, number>): bigint | null {
    const user = this.users.get(address.toLowerCase());
    if (!user || user.debtUSD <= 0) return null;
    const collateralKeys = Object.keys(user.collateralUSDByAsset);
    const debtKeys = Object.keys(user.debtUSDByAsset);
    if (collateralKeys.length === 0 || debtKeys.length === 0) return null;
    if (!Number.isFinite(user.liquidationThresholdRatio) || user.liquidationThresholdRatio <= 0) return null;

    let collateralUSD = 0;
    for (const asset of collateralKeys) {
      const multiplier = priceChanges.get(asset) ?? 1;
      collateralUSD += user.collateralUSDByAsset[asset] * multiplier;
    }
    let debtUSD = 0;
    for (const asset of debtKeys) {
      const multiplier = priceChanges.get(asset) ?? 1;
      debtUSD += user.debtUSDByAsset[asset] * multiplier;
    }
    if (debtUSD <= 0) return null;

    const estimatedHF = (collateralUSD * user.liquidationThresholdRatio) / debtUSD;
    if (!Number.isFinite(estimatedHF)) return null;
    // Clamp to a sane range before converting to bigint (Infinity is not representable).
    const clamped = Math.min(Math.max(estimatedHF, 0), 1e6);
    return BigInt(Math.round(clamped * 1e18));
  }

  /**
   * @notice Update a user's on-chain health factor
   * @dev Stores both the raw bigint (used for decisions) and its display mirror. When the on-chain
   *      average liquidation threshold is supplied it is stored as a ratio, which keeps the local
   *      price-move estimate exact.
   * @param address User address
   * @param healthFactorRaw Raw 1e18-scaled health factor
   * @param liquidationThresholdBps Average liquidation threshold in bps (e.g. 8250 = 82.5%)
   */
  updateUserHF(address: string, healthFactorRaw: bigint, liquidationThresholdBps?: bigint): void {
    const user = this.users.get(address.toLowerCase());
    if (user) {
      user.lastCheckedHFRaw = healthFactorRaw;
      user.lastCheckedHF = hfRawToNumber(healthFactorRaw);
      if (liquidationThresholdBps !== undefined && liquidationThresholdBps > 0n) {
        user.liquidationThresholdRatio = Number(liquidationThresholdBps) / 10000;
      }
      user.lastUpdated = Date.now();
    }
  }

  /**
   * @notice Get summary statistics
   * @dev Risk buckets are computed over the POOL tier only (WATCH is reported separately and is
   *      1.075 <= HF < 1.15 by definition). Buckets are non-overlapping and cover the whole range.
   * @return Statistics object with counts and totals
   */
  getStats(): {
    totalUsers: number;
    pool: number;
    watched: number;
    liquidatable: number;
    critical: number;
    warning: number;
    healthy: number;
    totalCollateralUSD: number;
    totalDebtUSD: number;
  } {
    const allUsers = this.getAllUsers();
    const poolUsers = allUsers.filter(u => u.tier === 'POOL');
    return {
      totalUsers: allUsers.length,
      pool: poolUsers.length,
      watched: allUsers.length - poolUsers.length,
      liquidatable: poolUsers.filter(u => u.lastCheckedHFRaw < HF_RAW.ONE).length,
      critical: poolUsers.filter(u => u.lastCheckedHFRaw >= HF_RAW.ONE && u.lastCheckedHFRaw < HF_RAW.CRITICAL).length,
      warning: poolUsers.filter(u => u.lastCheckedHFRaw >= HF_RAW.CRITICAL && u.lastCheckedHFRaw < HF_RAW.WARNING).length,
      healthy: poolUsers.filter(u => u.lastCheckedHFRaw >= HF_RAW.WARNING).length,
      totalCollateralUSD: allUsers.reduce((sum, u) => sum + u.collateralUSD, 0),
      totalDebtUSD: allUsers.reduce((sum, u) => sum + u.debtUSD, 0),
    };
  }

  /**
   * @notice Log current pool status
   * @dev Outputs detailed statistics to logger
   */
  logStatus(): void {
    const stats = this.getStats();
    logger.info(`Pool: ${stats.totalUsers} users (${stats.pool} pool / ${stats.watched} watch) | ${stats.liquidatable} liquidatable, ${stats.critical} critical | TVL $${(stats.totalCollateralUSD / 1000).toFixed(0)}K/$${(stats.totalDebtUSD / 1000).toFixed(0)}K`);
  }
}
