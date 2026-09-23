import { formatEther } from 'viem';
import { logger } from '../utils/logger';
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

  constructor(
    private userPool: UserPool,
    private healthChecker: HealthChecker,
    private optimizedLiquidation: OptimizedLiquidationService,
    private executor: LiquidationExecutor,
    private globalRpcClient: any,
    private accountAddress: string,
    private assetManager: AssetManager,
    private onLiquidationSuccess: () => Promise<void>
  ) {}

  /**
   * @notice Handle Chainlink price update events
   * @dev Optimized: Check high-risk users (HF <= 1.03) first, then update cache for all affected
   * @param updates Array of price updates from Chainlink
   */
  public async handlePriceChange(updates: PriceUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.priceUpdateTimestamp = Date.now();
    const highRiskUsers = new Set<string>();
    const allAffectedUsers = new Set<string>();
    for (const update of updates) {
      const assetAddress = update.asset.toLowerCase();
      const usersWithCollateral = this.userPool.getUsersWithCollateral(assetAddress);
      const usersWithDebt = this.userPool.getUsersWithDebt(assetAddress);
      const highRiskCollateral = usersWithCollateral.filter(u => u.lastCheckedHF <= 1.03);
      const highRiskDebt = usersWithDebt.filter(u => u.lastCheckedHF <= 1.03);
      highRiskCollateral.forEach(user => highRiskUsers.add(user.address));
      highRiskDebt.forEach(user => highRiskUsers.add(user.address));
      usersWithCollateral.forEach(user => allAffectedUsers.add(user.address));
      usersWithDebt.forEach(user => allAffectedUsers.add(user.address));
      const totalAffected = allAffectedUsers.size;
      const highRiskCount = highRiskUsers.size;
      if (totalAffected > 0) {
        const assetSymbol = this.assetManager.getSymbol(update.asset) || update.asset;
        const direction = update.percentChange > 0 ? '↑' : '↓';
        logger.info(`${assetSymbol} ${direction}${Math.abs(update.percentChange).toFixed(2)}% ($${update.oldPrice.toFixed(2)}→$${update.newPrice.toFixed(2)}) affects ${totalAffected} users (${highRiskCount} high-risk)`);
      }
    }
    if (!this.isCheckingUsers && highRiskUsers.size > 0) {
      this.checkHighRiskThenUpdateCache(Array.from(highRiskUsers), Array.from(allAffectedUsers));
    }
  }

  /**
   * @notice Check high-risk users first, execute if liquidatable, otherwise update cache for all affected
   */
  private async checkHighRiskThenUpdateCache(highRiskUsers: string[], allAffectedUsers: string[]): Promise<void> {
    if (this.isCheckingUsers) return;
    this.isCheckingUsers = true;
    try {
      const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
      logger.info(`Phase 1: Checking ${highRiskUsers.length} high-risk users (HF<=1.03) for liquidation (elapsed: ${elapsedSincePriceUpdate}ms)`);
      const highRiskCheckStart = Date.now();
      const highRiskHealthMap = await this.healthChecker.checkUsers(highRiskUsers);
      const highRiskCheckLatency = Date.now() - highRiskCheckStart;
      const liquidatable = this.healthChecker.filterLiquidatable(highRiskHealthMap);
      if (liquidatable.length > 0) {
        logger.info(`Found ${liquidatable.length} liquidatable (check: ${highRiskCheckLatency}ms)`);
        const availableUsers = liquidatable.filter(userHealth => !this.inFlightLiquidations.has(userHealth.user));
        if (availableUsers.length > 0) {
          const selection = await this.selectBestLiquidation(availableUsers);
          if (selection) {
            const success = await this.executeLiquidationWithParams(selection.user, selection.params, selection.gasSettings);
            if (success) {
               await this.onLiquidationSuccess();
               return;
            }
          }
        }
      }
      logger.info(`Phase 2: No liquidatable positions found, updating cache for ${allAffectedUsers.length} affected users`);
      const cacheUpdateStart = Date.now();
      const allHealthMap = await this.healthChecker.checkUsers(allAffectedUsers);
      const cacheUpdateLatency = Date.now() - cacheUpdateStart;
      let removedCount = 0;
      for (const [address, health] of allHealthMap.entries()) {
        if (health.healthFactor >= 1.1) {
          this.userPool.removeUser(address);
          removedCount++;
        } else {
          this.userPool.updateUserHF(address, health.healthFactor);
        }
      }
      logger.info(`Cache updated (${removedCount} removed, ${cacheUpdateLatency}ms)`);
    } catch (error) {
      logger.error('Error in two-phase health check:', error);
    } finally {
      this.isCheckingUsers = false;
    }
  }

  private async selectBestLiquidation(
    users: UserHealth[]
  ): Promise<{ user: UserHealth; params: LiquidationParams; gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint } } | null> {
    const paramsStart = Date.now();
    const paramsMap = await this.optimizedLiquidation.getLiquidationParamsForMultipleUsers(users);
    const paramsLatency = Date.now() - paramsStart;
    if (paramsMap.size === 0) {
      logger.warn('No valid liquidations found (all users failed validation or value < $100)');
      return null;
    }
    
    const validLiquidations = Array.from(paramsMap.values());
    validLiquidations.sort((a, b) => {
      const valueDiff = b.params.estimatedValue - a.params.estimatedValue;
      if (Math.abs(valueDiff) > 50) return valueDiff;
      return a.userHealth.healthFactor - b.userHealth.healthFactor;
    });
    
    const balance = await this.globalRpcClient.getBalance({ address: this.accountAddress });
    const balanceETH = Number(formatEther(balance));
    const fixedGasLimit = 920000n;
    let skippedCount = 0;
    
    for (const liq of validLiquidations) {
      const gasResult = await this.executor.calculateAffordableGasSettings(
        fixedGasLimit,
        liq.params.estimatedValue,
        balanceETH
      );
      
      if (gasResult) {
        const skip = skippedCount > 0 ? ` (skipped ${skippedCount})` : '';
        logger.info(`Selected${skip}: ${liq.params.collateralSymbol}→${liq.params.debtSymbol} HF:${liq.userHealth.healthFactor.toFixed(4)} value:$${liq.params.estimatedValue.toFixed(0)} gas:${gasResult.maxGasCostETH.toFixed(6)}ETH (${paramsLatency}ms)`);
        return { user: liq.userHealth, params: liq.params, gasSettings: gasResult.gasSettings };
      } else {
        skippedCount++;
        logger.debug(`Skip #${skippedCount} ${liq.params.collateralSymbol}→${liq.params.debtSymbol} ($${liq.params.estimatedValue.toFixed(0)}): insufficient balance`);
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
        gasSettings
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
