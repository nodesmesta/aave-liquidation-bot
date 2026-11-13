import { formatEther, parseAbi, Address } from 'viem';
import { logger } from '../utils/logger';
import { config } from '../config';
import { HF, HF_RAW, TIMING, formatHF, isPoolTierRaw, shouldPruneRaw } from '../config/thresholds';
import { UserHealth, HealthChecker } from './HealthChecker';
import { LiquidationExecutor } from './LiquidationExecutor';
import { PriceUpdate } from './PriceOracle';
import { OptimizedLiquidationService, LiquidationParams } from './OptimizedLiquidationService';
import { UserPool } from './UserPool';


import { AssetManager } from './AssetManager';

export class LiquidationManager {
  private isCheckingUsers = false;
  private inFlightLiquidations: Set<string> = new Set();
  private priceUpdateTimestamp: number = 0;
  /** Assets whose price moved while a check was already running. Replayed once the lock is free
   *  instead of being dropped, so a crash during a long sweep is never missed. */
  private pendingPriceChanges: Map<string, number> = new Map();
  private pendingReplayScheduled = false;

  constructor(
    private userPool: UserPool,
    private healthChecker: HealthChecker,
    private optimizedLiquidation: OptimizedLiquidationService,
    private executor: LiquidationExecutor,
    private globalRpcClient: any,
    private accountAddress: string,
    private assetManager: AssetManager,
    private onLiquidationSuccess: (liquidatedUser: string) => Promise<void>
  ) {}

  /**
   * @notice Handle Chainlink price update events
   * @dev Two-stage filtering keeps RPC usage proportional to actual risk:
   *      1. Every affected user gets a local HF estimate from the cached per-asset USD breakdown.
   *         Only users whose estimate can fall below PRICE_TRIGGER are sent to the RPC.
   *      2. High-risk users (cached HF <= 1.03) are checked first, then the rest.
   *      Updates arriving while a check is running are queued and replayed, never dropped.
   * @param updates Array of price updates from Chainlink
   */
  public async handlePriceChange(updates: PriceUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.priceUpdateTimestamp = Date.now();

    // Price multipliers for the local estimate (newPrice / oldPrice).
    const priceChanges = new Map<string, number>();
    for (const update of updates) {
      const asset = update.asset.toLowerCase();
      const multiplier = update.oldPrice > 0 ? update.newPrice / update.oldPrice : 1;
      priceChanges.set(asset, multiplier);
    }

    const highRiskUsers = new Set<string>();
    const allAffectedUsers = new Set<string>();
    const candidatesForRpc = new Set<string>();

    for (const update of updates) {
      const assetAddress = update.asset.toLowerCase();
      const usersWithCollateral = this.userPool.getUsersWithCollateral(assetAddress);
      const usersWithDebt = this.userPool.getUsersWithDebt(assetAddress);

      for (const user of [...usersWithCollateral, ...usersWithDebt]) {
        allAffectedUsers.add(user.address);
        if (user.lastCheckedHFRaw <= HF_RAW.HIGH_RISK) {
          highRiskUsers.add(user.address);
          candidatesForRpc.add(user.address);
          continue;
        }
        // Local estimate: skip the RPC entirely when the move cannot push this user near 1.0.
        const estimated = this.userPool.estimateHFAfterPriceChange(user.address, priceChanges);
        if (estimated === null) {
          // No breakdown available (e.g. restored snapshot) - must verify on-chain.
          candidatesForRpc.add(user.address);
          continue;
        }
        if (estimated <= HF_RAW.WARNING) {
          candidatesForRpc.add(user.address);
        }
      }

      const assetSymbol = this.assetManager.getSymbol(update.asset) || update.asset;
      const direction = update.percentChange > 0 ? '↑' : '↓';
      logger.info(
        `${assetSymbol} ${direction}${Math.abs(update.percentChange).toFixed(2)}% ` +
        `($${update.oldPrice.toFixed(2)}→$${update.newPrice.toFixed(2)}) affects ${allAffectedUsers.size} users ` +
        `(${highRiskUsers.size} high-risk, ${candidatesForRpc.size} need RPC)`
      );
    }

    if (candidatesForRpc.size === 0) {
      logger.debug(`Price move affects ${allAffectedUsers.size} users but none can reach HF ${HF.PRICE_TRIGGER} - no RPC needed`);
      return;
    }

    if (this.isCheckingUsers) {
      // Queue instead of dropping: merge the assets so the replay re-evaluates them.
      for (const asset of priceChanges.keys()) {
        this.pendingPriceChanges.set(asset, priceChanges.get(asset)!);
      }
      logger.info(`Check already running - queued ${priceChanges.size} asset move(s) for replay`);
      return;
    }

    await this.checkHighRiskThenUpdateCache(Array.from(highRiskUsers), Array.from(candidatesForRpc));
  }

  /**
   * @notice Replay price moves that arrived while a check was running
   * @dev Runs after the lock is released so no update is silently lost.
   */
  private schedulePendingReplay(): void {
    if (this.pendingReplayScheduled || this.pendingPriceChanges.size === 0) return;
    this.pendingReplayScheduled = true;
    const pending = new Map(this.pendingPriceChanges);
    this.pendingPriceChanges.clear();
    setImmediate(() => {
      this.pendingReplayScheduled = false;
      const updates: PriceUpdate[] = [];
      for (const [asset, multiplier] of pending) {
        updates.push({
          asset,
          oldPrice: 1,
          newPrice: multiplier,
          percentChange: (multiplier - 1) * 100,
          source: 'chainlink',
        });
      }
      void this.handlePriceChange(updates).catch((error) =>
        logger.error('Error replaying queued price changes:', error)
      );
    });
  }

  /**
   * @notice Check high-risk users first, execute if liquidatable, otherwise check and update cache for all affected
   */
  private async checkHighRiskThenUpdateCache(highRiskUsers: string[], allAffectedUsers: string[]): Promise<void> {
    if (this.isCheckingUsers) return;
    this.isCheckingUsers = true;
    try {
      const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;

      let highRiskHealthMap = new Map<string, UserHealth>();
      // Phase 1: Prioritize high-risk users (HF <= 1.03) if any exist
      if (highRiskUsers.length > 0) {
        logger.info(`Phase 1: Checking ${highRiskUsers.length} high-risk users (HF<=${HF.HIGH_RISK}) for liquidation (initiation: ${elapsedSincePriceUpdate}ms)`);
        const highRiskCheckStart = Date.now();
        highRiskHealthMap = await this.healthChecker.checkUsers(highRiskUsers);
        const highRiskCheckLatency = Date.now() - highRiskCheckStart;
        const liquidatable = this.healthChecker.filterLiquidatable(highRiskHealthMap);
        if (liquidatable.length > 0) {
          logger.info(`Phase 1: Found ${liquidatable.length} liquidatable (check: ${highRiskCheckLatency}ms)`);
          const availableUsers = liquidatable.filter(userHealth => !this.inFlightLiquidations.has(userHealth.user));
          if (availableUsers.length > 0) {
            const selection = await this.selectBestLiquidation(availableUsers);
            if (selection) {
              const success = await this.executeLiquidationWithParams(selection.user, selection.params, selection.gasSettings);
              if (success) {
                await this.onLiquidationSuccess(selection.user.user);
              }
            }
          }
        } else {
          const userHFs = Array.from(highRiskHealthMap.values())
            .map(h => `${h.user.slice(0, 6)}...${h.user.slice(-4)}: HF ${formatHF(h.healthFactorRaw)}`)
            .join(', ');
          logger.info(`Phase 1: 0 liquidatable (${highRiskUsers.length} checked on-chain in ${highRiskCheckLatency}ms) | Live HFs: [${userHFs}]`);
        }
      } else {
        logger.info(`Phase 1: 0 high-risk users (HF<=${HF.HIGH_RISK}). Evaluating all ${allAffectedUsers.length} affected users on-chain.`);
      }

      // Phase 2: Check remaining affected users (avoiding duplicate multicall for highRiskUsers), and update userPool cache
      const highRiskSet = new Set(highRiskUsers.map(u => u.toLowerCase()));
      const remainingUsers = allAffectedUsers.filter(u => !highRiskSet.has(u.toLowerCase()));

      const phase2Label = highRiskUsers.length > 0
        ? `Phase 2: Updating cache and checking remaining ${remainingUsers.length} affected users (${highRiskUsers.length} already checked in Phase 1)`
        : `Phase 2: Evaluating and syncing ${allAffectedUsers.length} affected users`;
      logger.info(phase2Label);

      const cacheUpdateStart = Date.now();
      const remainingHealthMap = remainingUsers.length > 0
        ? await this.healthChecker.checkUsers(remainingUsers)
        : new Map<string, UserHealth>();
      const cacheUpdateLatency = Date.now() - cacheUpdateStart;

      // Merge health maps from Phase 1 and Phase 2
      const allHealthMap = new Map<string, UserHealth>([...highRiskHealthMap, ...remainingHealthMap]);

      // Check if any user in Phase 2 escalated to liquidatable (HF < 1.0)
      const phase2Liquidatable = this.healthChecker.filterLiquidatable(allHealthMap);
      if (phase2Liquidatable.length > 0) {
        const availableUsers = phase2Liquidatable.filter(userHealth => !this.inFlightLiquidations.has(userHealth.user));
        if (availableUsers.length > 0) {
          logger.info(`Phase 2: Found ${availableUsers.length} liquidatable user(s) escalated from affected pool!`);
          const selection = await this.selectBestLiquidation(availableUsers);
          if (selection) {
            const success = await this.executeLiquidationWithParams(selection.user, selection.params, selection.gasSettings);
            if (success) {
              await this.onLiquidationSuccess(selection.user.user);
            }
          }
        }
      }

      // Update UserPool cache: record updated HF, keep the tier label truthful, and prune only users
      // that left the tracked range for both tiers (HF >= 1.15 or fully repaid).
      // This runs even after a successful liquidation, so the rest of the batch is not re-fetched
      // from scratch on the next price tick.
      let removedCount = 0;
      let newlyHighRiskCount = 0;
      let promotedCount = 0;
      for (const [address, health] of allHealthMap.entries()) {
        if (health.totalDebtBase === 0n || shouldPruneRaw(health.healthFactorRaw)) {
          this.userPool.removeUser(address);
          removedCount++;
          continue;
        }
        const tracked = this.userPool.getUser(address);
        const nextTier = isPoolTierRaw(health.healthFactorRaw) ? 'POOL' : 'WATCH';
        if (tracked && tracked.tier !== nextTier) {
          this.userPool.setTier(address, nextTier);
          if (nextTier === 'POOL') promotedCount++;
        }
        this.userPool.updateUserHF(address, health.healthFactorRaw, health.currentLiquidationThreshold);
        if (health.healthFactorRaw <= HF_RAW.HIGH_RISK) {
          newlyHighRiskCount++;
        }
      }
      logger.info(`Cache updated: ${allHealthMap.size} users checked (${removedCount} removed, ${promotedCount} escalated to POOL, ${newlyHighRiskCount} now HF<=${HF.HIGH_RISK}, ${cacheUpdateLatency}ms)`);
    } catch (error) {
      logger.error('Error in two-phase health check:', error);
    } finally {
      this.isCheckingUsers = false;
      this.schedulePendingReplay();
    }
  }

  /**
   * @notice Rank candidates cheaply, then compute full params only for the top few
   * @dev `getLiquidationParamsForMultipleUsers` issues a large multicall (bitmap + every user
   *      reserve + prices). Running it for every liquidatable user and then using only one result
   *      wasted most of that work. Candidates are now pre-ranked from cached USD values and only
   *      the top `MAX_PARAM_CANDIDATES` get the expensive treatment.
   */
  private async selectBestLiquidation(
    users: UserHealth[]
  ): Promise<{ user: UserHealth; params: LiquidationParams; gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint } } | null> {
    const paramsStart = Date.now();

    // Cheap pre-ranking: cached debt USD is a good proxy for liquidation size, and a lower HF
    // means a bigger fraction of the debt is liquidatable.
    const ranked = [...users].sort((a, b) => {
      const aTracked = this.userPool.getUser(a.user);
      const bTracked = this.userPool.getUser(b.user);
      const aScore = (aTracked?.debtUSD ?? 0) * (1 - Math.min(a.healthFactor, 1));
      const bScore = (bTracked?.debtUSD ?? 0) * (1 - Math.min(b.healthFactor, 1));
      if (Math.abs(bScore - aScore) > 1) return bScore - aScore;
      return a.healthFactorRaw < b.healthFactorRaw ? -1 : a.healthFactorRaw > b.healthFactorRaw ? 1 : 0;
    });
    const shortlist = ranked.slice(0, TIMING.MAX_PARAM_CANDIDATES);
    if (ranked.length > shortlist.length) {
      logger.info(`Pre-ranked ${ranked.length} liquidatable users, computing params for top ${shortlist.length}`);
    }

    const paramsMap = await this.optimizedLiquidation.getLiquidationParamsForMultipleUsers(shortlist);
    const paramsLatency = Date.now() - paramsStart;
    if (paramsMap.size === 0) {
      logger.warn('No valid liquidations found (all users failed validation or value < $100)');
      return null;
    }
    
    const validLiquidations = Array.from(paramsMap.values());
    validLiquidations.sort((a, b) => {
      const valueDiff = b.params.estimatedValue - a.params.estimatedValue;
      if (Math.abs(valueDiff) > 50) return valueDiff;
      return a.userHealth.healthFactorRaw < b.userHealth.healthFactorRaw ? -1 : 1;
    });
    
    const balance = await this.globalRpcClient.getBalance({ address: this.accountAddress });
    const balanceETH = Number(formatEther(balance));
    const fixedGasLimit = 920000n;
    let skippedCount = 0;

    // Ambil harga ETH live dari Aave Oracle untuk kalkulasi gas USD
    const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as Address;
    let ethPriceUSD = 3000;
    try {
      const ethPriceRaw = await this.globalRpcClient.readContract({
        address: config.aave.oracle as Address,
        abi: parseAbi(['function getAssetPrice(address asset) external view returns (uint256)']),
        functionName: 'getAssetPrice',
        args: [WETH_ADDRESS],
      });
      ethPriceUSD = Number(ethPriceRaw) / 1e8;
    } catch {
      logger.debug(`Using fallback ETH price: $${ethPriceUSD}`);
    }

    // Fetch network fees once instead of once per candidate.
    const baseFees = await this.executor.getEstimatedFees();
    
    for (const liq of validLiquidations) {
      const flashloanPremiumUSD = liq.params.debtToCoverUSD * (this.executor.getFlashloanPremiumBps() / 10000);
      const grossProfitUSD = liq.params.estimatedValue - liq.params.debtToCoverUSD - flashloanPremiumUSD;
      const gasResult = this.executor.calculateAffordableGasSettingsWithFees(
        baseFees,
        fixedGasLimit,
        liq.params.estimatedValue,
        balanceETH,
        grossProfitUSD,
        ethPriceUSD
      );
      
      if (gasResult) {
        const skip = skippedCount > 0 ? ` (skipped ${skippedCount})` : '';
        const netStr = gasResult.netProfitUSD !== undefined ? ` netProfit:$${gasResult.netProfitUSD.toFixed(2)}` : '';
        logger.info(`Selected${skip}: ${liq.params.collateralSymbol}→${liq.params.debtSymbol} HF:${formatHF(liq.userHealth.healthFactorRaw)} value:$${liq.params.estimatedValue.toFixed(0)} premium:$${flashloanPremiumUSD.toFixed(2)} gas:${gasResult.maxGasCostETH.toFixed(6)}ETH ($${(gasResult.maxGasCostUSD || 0).toFixed(2)})${netStr} (${paramsLatency}ms)`);
        
        // Resolve Uniswap V3 route ONLY for this single selected pair right before execution
        await this.optimizedLiquidation.attachSwapRoute(liq.params);

        return { user: liq.userHealth, params: liq.params, gasSettings: gasResult.gasSettings };
      } else {
        skippedCount++;
        logger.debug(`Skip #${skippedCount} ${liq.params.collateralSymbol}→${liq.params.debtSymbol} ($${liq.params.estimatedValue.toFixed(0)}): insufficient balance or unprofitable`);
      }
    }
    
    logger.warn(`No affordable liquidations: balance ${balanceETH.toFixed(6)}ETH insufficient for ${validLiquidations.length} opportunities`);
    return null;
  }

  private async executeLiquidationWithParams(
    userHealth: UserHealth,
    params: LiquidationParams,
    gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }
  ): Promise<boolean> {
    this.inFlightLiquidations.add(userHealth.user);
    try {
      const tx = await this.executor.executeLiquidation(
        params.collateralAsset,
        params.debtAsset,
        params.userAddress,
        params.debtToCover,
        params.estimatedValue,
        gasSettings,
        params.swapPath
      );
      const totalLatency = Date.now() - this.priceUpdateTimestamp;
      if (tx.success) {
        logger.info(`✓ Liquidated ${tx.txHash} (price→tx: ${totalLatency}ms)`);
        return true;
      }
      return false;
    } finally {
      this.inFlightLiquidations.delete(userHealth.user);
    }
  }
}
