import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { config, validateConfig, getAssetSymbol } from './config';
import { logger } from './utils/logger';
import { createAccount } from './utils/wallet';
import { HealthChecker, UserHealth } from './services/HealthChecker';
import { LiquidationExecutor } from './services/LiquidationExecutor';
import { PriceOracle, PriceUpdate } from './services/PriceOracle';
import { SubgraphService } from './services/SubgraphService';
import { OptimizedLiquidationService } from './services/OptimizedLiquidationService';
import { UserPool } from './services/UserPool';
import { SupportedAsset } from './config/assets';

class LiquidatorBot {
  private rpcUrl: string;
  private account: ReturnType<typeof createAccount>;
  private healthChecker: HealthChecker;
  private executor: LiquidationExecutor;
  private priceOracle: PriceOracle;
  private subgraphService: SubgraphService;
  private optimizedLiquidation: OptimizedLiquidationService;
  private userPool: UserPool;
  private isInitialized = false;
  private isPriceMonitoring = false;
  private isCheckingUsers = false;
  private isRestarting = false;
  private pendingUserChecks: Set<string> = new Set();
  private static usingPrimaryWss = true;

  constructor() {
    this.rpcUrl = config.network.rpcUrl;
    const publicClient = createPublicClient({
      chain: base,
      transport: http(config.network.rpcUrl),
    });
    this.account = createAccount();
    this.healthChecker = new HealthChecker(config.network.rpcUrl, config.aave.pool);
    this.executor = new LiquidationExecutor(config.network.rpcUrl, this.account);
    this.priceOracle = new PriceOracle(publicClient);
    this.subgraphService = new SubgraphService(config.aave.subgraphUrl);
    this.optimizedLiquidation = new OptimizedLiquidationService(
      config.network.rpcUrl,
      config.aave.protocolDataProvider
    );
    this.userPool = new UserPool();
  }

  /**
   * @notice Initialize user pool from Subgraph and on-chain validation
   * @dev Queries USDC borrowers, validates HF < 1.1, filters hedged positions
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing liquidation bot...');
      logger.info('Strategy: USDC debt users + on-chain validation (HF < 1.1)');
      const candidatesMap = await this.subgraphService.getActiveBorrowers();
      if (candidatesMap.size === 0) {
        logger.warn('No liquidation candidates found from Subgraph');
        this.isInitialized = true;
        return;
      }
      logger.info(`Found ${candidatesMap.size} candidates after asset filtering`);
      const userAddresses = Array.from(candidatesMap.keys());
      const validationResults = await this.subgraphService.validateUsersOnChain(
        userAddresses,
        config.network.rpcUrl,
        config.aave.pool,
        config.aave.protocolDataProvider
      );
      if (validationResults.size === 0) {
        logger.warn('No critical risk users (HF < 1.1) found on-chain');
        this.isInitialized = true;
        return;
      }
      logger.info(`Found ${validationResults.size} critical risk users (HF < 1.1)`);
      for (const [address, data] of validationResults.entries()) {
        const collateralSymbols = data.collateralAssets.map(addr => getAssetSymbol(addr) || addr);
        this.userPool.addUser({
          address: address,
          estimatedHF: data.hf,
          collateralUSD: data.collateral,
          debtUSD: data.debt,
          collateralAssets: collateralSymbols,
          debtAssets: data.debtAssets.map(addr => getAssetSymbol(addr) || addr),
          lastCheckedHF: data.hf,
          lastUpdated: Date.now(),
          addedAt: Date.now()
        });
      }
      this.userPool.logStatus();
      this.isInitialized = true;
      logger.info('User pool initialization complete!');
    } catch (error) {
      logger.error('Failed to initialize user pool:', error);
      throw error;
    }
  }

  /**
   * @notice Start liquidation bot
   * @dev Validates config, checks connection, initializes pool, starts monitoring
   */
  async start(): Promise<void> {
    logger.info('Starting Liquidator Bot...');
    validateConfig();
    logger.info(`Bot Wallet: ${this.account.address}`);
    await this.checkConnection();
    await this.initialize();
    await this.ensurePriceMonitoring();
    logger.info('Liquidator Bot started successfully!');
  }

  /**
   * @notice Stop liquidation bot
   * @dev Clears state, stops monitoring, logs final stats
   */
  async stop(): Promise<void> {
    logger.info('Stopping Liquidator Bot...');
    this.isPriceMonitoring = false;
    this.isInitialized = false;
    await this.waitForOngoingChecks(5000);
    this.pendingUserChecks.clear();
    this.isCheckingUsers = false;
    this.priceOracle.stopPriceMonitoring();
    logger.info('Final Statistics:', this.executor.getStats());
    logger.info('Bot stopped');
  }

  /**
   * @notice Restart user pool after successful liquidation
   * @dev Clears pool, stops monitoring, re-initializes from scratch with race condition protection
   */
  async restart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }
    this.isRestarting = true;
    logger.info('Restarting bot for fresh user pool...');
    this.isInitialized = false;
    this.isPriceMonitoring = false;
    await this.waitForOngoingChecks(10000);
    await this.stop();
    this.userPool.clear();
    await this.delay(1000);
    await this.start();
    logger.info('Bot restart complete - all state fresh!');
    this.isRestarting = false;
  }

  /**
   * @notice Restart bot with provider failover
   * @dev Toggles between Alchemy and Infura WSS providers
   */
  private async restartBot(): Promise<void> {
    if (this.isRestarting) {
      logger.warn('Restart already in progress, failover skipped');
      return;
    }
    this.isRestarting = true;
    LiquidatorBot.usingPrimaryWss = !LiquidatorBot.usingPrimaryWss;
    const nextProvider = LiquidatorBot.usingPrimaryWss ? 'Alchemy' : 'Infura';
    logger.warn(`Switching to ${nextProvider}...`);
    this.isInitialized = false;
    this.isPriceMonitoring = false;
    await this.waitForOngoingChecks(10000);
    await this.stop();
    await this.delay(1000);
    await this.start();
    logger.info('Failover restart complete');
    this.isRestarting = false;
  }

  /**
   * @notice Wait for ongoing user checks to complete
   * @dev Polls isCheckingUsers flag with timeout to prevent deadlock
   * @param maxWaitMs Maximum time to wait in milliseconds
   */
  private async waitForOngoingChecks(maxWaitMs: number): Promise<void> {
    if (!this.isCheckingUsers) return;
    const startTime = Date.now();
    while (this.isCheckingUsers && (Date.now() - startTime) < maxWaitMs) {
      await this.delay(100);
    }
    if (this.isCheckingUsers) {
      logger.warn(`User checks still ongoing after ${maxWaitMs}ms timeout`);
      this.isCheckingUsers = false;
    }
  }

  /**
   * @notice Delay helper for async operations
   * @dev Simple Promise-based delay
   * @param ms Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * @notice Convert asset symbols to addresses for price monitoring
   * @dev Only returns addresses with Chainlink oracles (monitorPrice: true), filters stablecoins
   * @param symbols Array of asset symbols
   * @return Array of asset addresses to monitor
   */
  private getAssetAddressesFromSymbols(symbols: string[]): string[] {
    const addresses: string[] = [];
    for (const symbol of symbols) {
      const asset = SupportedAsset[symbol];
      if (asset && asset.monitorPrice) {
        addresses.push(asset.address);
      }
    }
    return addresses;
  }

  /**
   * @notice Verify RPC connection and network
   * @dev Checks network ID matches config, logs block number and wallet balance
   */
  private async checkConnection(): Promise<void> {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl),
    });
    const chainId = await publicClient.getChainId();
    const blockNumber = await publicClient.getBlockNumber();
    const balance = await publicClient.getBalance({ address: this.account.address });
    logger.info(`Connected to network: Base (Chain ID: ${chainId})`);
    logger.info(`Current block: ${blockNumber}`);
    logger.info(`Wallet balance: ${formatEther(balance)} ETH`);
    if (Number(chainId) !== base.id) {
      throw new Error(`Wrong network! Expected ${base.id}, got ${chainId}`);
    }
  }

  /**
   * @notice Ensure price monitoring is active and synced with current user pool
   * @dev Monitors both collateral (price drops) and debt (price rises) for comprehensive coverage
   */
  private async ensurePriceMonitoring(): Promise<void> {
    if (this.isPriceMonitoring) return;
    const uniqueCollateralSymbols = this.userPool.getUniqueCollateralAssets();
    const uniqueDebtSymbols = this.userPool.getUniqueDebtAssets();
    const allAssetSymbols = [...new Set([...uniqueCollateralSymbols, ...uniqueDebtSymbols])];
    const assetsToMonitor = this.getAssetAddressesFromSymbols(allAssetSymbols);
    if (assetsToMonitor.length === 0) {
      logger.warn('No volatile assets to monitor (UserPool empty or only stablecoins)');
      return;
    }
    const monitoredSymbols = assetsToMonitor
      .map(addr => getAssetSymbol(addr))
      .filter(symbol => SupportedAsset[symbol]?.monitorPrice);
    logger.info('Starting Chainlink event-based multi-asset price monitoring (collateral + debt)');
    this.priceOracle.setFatalErrorHandler(() => {
      logger.error('Fatal WebSocket error detected, initiating bot restart...');
      this.restartBot();
    });
    logger.info(`Monitoring: ${assetsToMonitor.length} volatile assets (${monitoredSymbols.join(', ')})`);
    const selectedWss = LiquidatorBot.usingPrimaryWss 
      ? config.network.wssUrl 
      : config.network.wssUrlFallback || config.network.wssUrl;
    await this.priceOracle.startPriceMonitoring(
      assetsToMonitor,
      this.handlePriceChange.bind(this),
      selectedWss
    );
    this.isPriceMonitoring = true;
  }

  /**
   * @notice Handle Chainlink price update events
   * @dev Logs price changes, identifies affected users, triggers health checks
   * @param updates Array of price updates from Chainlink
   */
  private async handlePriceChange(updates: PriceUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    if (!this.isInitialized || this.isRestarting) return;
    for (const update of updates) {
      const assetSymbol = getAssetSymbol(update.asset);
      const usersWithCollateral = this.userPool.getUsersWithCollateral(assetSymbol);
      const usersWithDebt = this.userPool.getUsersWithDebt(assetSymbol);
      const totalAffected = new Set([...usersWithCollateral, ...usersWithDebt]).size;
      if (totalAffected > 0) {
        logger.info(
          `${assetSymbol} ${update.percentChange > 0 ? '↑' : '↓'}${Math.abs(update.percentChange).toFixed(2)}% ` +
          `($${update.oldPrice.toFixed(2)} → $${update.newPrice.toFixed(2)}) affects ` +
          `${totalAffected} users (${usersWithCollateral.length} collateral, ${usersWithDebt.length} debt)`
        );
        usersWithCollateral.forEach(user => this.pendingUserChecks.add(user.address));
        usersWithDebt.forEach(user => this.pendingUserChecks.add(user.address));
      }
    }
    if (!this.isCheckingUsers && this.pendingUserChecks.size > 0) {
      this.checkPendingUsers();
    }
  }

  /**
   * @notice Process pending user health checks asynchronously
   * @dev Batch-checks users flagged by price updates, auto-processes new pending users after completion
   */
  private async checkPendingUsers(): Promise<void> {
    if (this.isCheckingUsers) return;
    if (this.pendingUserChecks.size === 0) return;
    if (!this.isInitialized || this.isRestarting) {
      this.pendingUserChecks.clear();
      return;
    }
    this.isCheckingUsers = true;
    try {
      const usersToCheck = Array.from(this.pendingUserChecks);
      this.pendingUserChecks.clear();
      logger.info(`Checking ${usersToCheck.length} affected users immediately...`);
      if (!this.isInitialized) return;
      await this.checkTrackedUsers(usersToCheck);
    } catch (error) {
      logger.error('Error checking pending users:', error);
    } finally {
      this.isCheckingUsers = false;
      if (this.pendingUserChecks.size > 0 && this.isInitialized && !this.isRestarting) {
        setImmediate(() => this.checkPendingUsers());
      }
    }
  }

  /**
   * @notice Check health factors for tracked users and execute liquidations
   * @dev Batch-checks users, removes safe users, filters liquidatable, executes liquidations
   * @param userAddresses Array of user addresses to check
   */
  private async checkTrackedUsers(userAddresses: string[]): Promise<void> {
    if (userAddresses.length === 0) return;
    const healthMap = await this.healthChecker.checkUsers(userAddresses);
    let removedCount = 0;
    for (const [address, health] of healthMap.entries()) {
      const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
      if (health.healthFactor >= 1.1) {
        this.userPool.removeUser(address);
        removedCount++;
        logger.debug(`Removed ${shortAddress} from pool (HF ${health.healthFactor.toFixed(4)} >= 1.1 threshold)`);
      } else {
        this.userPool.updateUserHF(address, health.healthFactor);
      }
    }
    if (removedCount > 0) {
      logger.info(`Removed ${removedCount} recovered users from pool (HF >= 1.1)`);
    }
      const liquidatable = this.healthChecker.filterLiquidatable(healthMap);
      if (liquidatable.length === 0) return;
      logger.info(`Found ${liquidatable.length} liquidatable users`);
      const liquidationPromises = liquidatable.map(userHealth => 
        this.executeLiquidation(userHealth)
          .then(success => ({ user: userHealth.user, success }))
          .catch(error => {
            logger.error(`Liquidation error for ${userHealth.user}:`, error);
            return { user: userHealth.user, success: false };
          })
      );
      const results = await Promise.allSettled(liquidationPromises);
      let successfulLiquidations = 0;
      let failedLiquidations = 0;
      const successfullyLiquidatedUsers: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { user, success } = result.value;
          if (success) {
            successfulLiquidations++;
            successfullyLiquidatedUsers.push(user);
            logger.info(`Liquidated ${user}`);
          } else {
            failedLiquidations++;
            logger.warn(`Failed to liquidate ${user}`);
          }
        } else {
          failedLiquidations++;
          logger.error(`Promise rejected:`, result.reason);
        }
      }
    logger.info(`Liquidation summary: ${successfulLiquidations} successful, ${failedLiquidations} failed`);
    
    if (successfullyLiquidatedUsers.length > 0) {
      logger.info(`${successfullyLiquidatedUsers.length} liquidation(s) successful, initiating auto-restart...`);
      await this.restart();
    }
  }

  /**
   * @notice Execute liquidation for a single user
   * @dev Gets liquidation params via multicall (1 RPC vs 9), checks gas balance, executes on-chain
   * @param userHealth User health data from multicall
   */
  private async executeLiquidation(userHealth: UserHealth): Promise<boolean> {
    logger.info(`Executing liquidation for ${userHealth.user} (HF: ${userHealth.healthFactor})`);
    const params = await this.optimizedLiquidation.getLiquidationParams(userHealth);
    if (!params) return false;
    logger.info(
      `Selected: ${params.collateralSymbol}→${params.debtSymbol} ` +
      `(bonus: ${params.liquidationBonus}%, value: ~$${params.estimatedValue.toFixed(2)})`
    );
    logger.info(
      `Debt to cover: ${formatUnits(params.debtToCover, 6)} ${params.debtSymbol}`
    );
    logger.info(`Executing liquidation...`);
    const tx = await this.executor.executeLiquidation(
      params.collateralAsset,
      params.debtAsset,
      params.userAddress,
      params.debtToCover
    );
    
    if (tx.success) {
      logger.info(`Liquidation successful! TX: ${tx.txHash}`);
      return true;
    } else {
      logger.error(`Liquidation failed: ${tx.error}`);
      return false;
    }
  }

  /**
   * @notice Log current bot status and liquidation statistics
   * @dev Displays network info, wallet address, and executor stats
   */
  private logStatus(): void {
    const stats = this.executor.getStats();
    logger.info('Bot Status');
    logger.info(`Network: Base (${base.id})`);
    logger.info(`Wallet: ${this.account.address}`);
    logger.info(`Total Attempts: ${stats.totalAttempts}`);
    logger.info(`Successful: ${stats.successfulLiquidations}`);
    logger.info(`Success Rate: ${stats.successRate.toFixed(2)}%`);
  }
}

/**
 * @notice Main entry point for the liquidator bot
 * @dev Initializes bot, sets up signal handlers (SIGINT, SIGTERM), starts monitoring
 */
async function main() {
  const bot = new LiquidatorBot();
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal');
    await bot.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal');
    await bot.stop();
    process.exit(0);
  });
  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { LiquidatorBot };
