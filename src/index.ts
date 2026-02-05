import { createPublicClient, http, formatEther, formatUnits, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config, validateConfig, getAssetSymbol } from './config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './utils/logger';
import { createAccount } from './utils/wallet';
import { HealthChecker, UserHealth } from './services/HealthChecker';
import { LiquidationExecutor } from './services/LiquidationExecutor';
import { PriceOracle, PriceUpdate } from './services/PriceOracle';
import { SubgraphService } from './services/SubgraphService';
import { OptimizedLiquidationService } from './services/OptimizedLiquidationService';
import { UserPool } from './services/UserPool';
import { SupportedAsset } from './config/assets';
import { LiquidationParams } from './services/OptimizedLiquidationService';

class LiquidatorBot {
  private rpcUrl: string;
  private publicClient: any;
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
  private inFlightLiquidations: Set<string> = new Set();
  private priceUpdateTimestamp: number = 0;

  constructor() {
    this.rpcUrl = config.network.rpcUrl;
    const customChain: Chain = {
      ...basePreconf,
      rpcUrls: {
        ...basePreconf.rpcUrls,
        default: { http: [config.network.rpcUrl] },
      },
    } as Chain;
    this.publicClient = createPublicClient({
      chain: customChain,
      transport: http(config.network.rpcUrl),
    });
    this.account = createAccount();
    this.healthChecker = new HealthChecker(config.network.rpcUrl, config.aave.pool);
    this.executor = new LiquidationExecutor(
      config.network.rpcUrl,
      this.account,
      config.network.wssUrl
    );
    this.priceOracle = new PriceOracle(this.publicClient);
    this.subgraphService = new SubgraphService(config.aave.subgraphUrl);
    this.optimizedLiquidation = new OptimizedLiquidationService(
      config.network.rpcUrl,
      config.aave.protocolDataProvider
    );
    this.userPool = new UserPool();
  }

  /**
   * @notice Initialize user pool from Subgraph and on-chain validation
   * @dev Queries USDC borrowers, validates HF < 1.05
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing bot (strategy: USDC debt, HF < 1.075)...');
      await this.executor.initialize();
      const candidatesMap = await this.subgraphService.getActiveBorrowers();
      if (candidatesMap.size === 0) {
        logger.warn('No candidates found from subgraph');
        this.isInitialized = true;
        return;
      }
      const userAddresses = Array.from(candidatesMap.keys());
      const validationResults = await this.subgraphService.validateUsersOnChain(
        userAddresses,
        config.network.rpcUrl,
        config.aave.pool,
        config.aave.protocolDataProvider
      );
      if (validationResults.size === 0) {
        logger.warn('No at-risk users found on-chain');
        this.isInitialized = true;
        return;
      }
      logger.info(`Loaded ${validationResults.size} users (${candidatesMap.size} scanned)`);
      for (const [address, data] of validationResults.entries()) {
        const collateralSymbols = data.collateralAssets.map((addr: string) => getAssetSymbol(addr) || addr);
        this.userPool.addUser({
          address: address,
          estimatedHF: data.hf,
          collateralUSD: data.collateral,
          debtUSD: data.debt,
          collateralAssets: collateralSymbols,
          debtAssets: data.debtAssets.map((addr: string) => getAssetSymbol(addr) || addr),
          lastCheckedHF: data.hf,
          lastUpdated: Date.now(),
          addedAt: Date.now()
        });
      }
      this.userPool.logStatus();
      this.isInitialized = true;
      logger.info('Initialization complete');
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
    logger.info('Starting liquidation bot...');
    validateConfig();
    logger.info(`Wallet: ${this.account.address}`);
    await this.checkConnection();
    await this.initialize();
    await this.ensurePriceMonitoring();
    setInterval(() => {
      this.exportUserPoolSnapshot();
    }, 10 * 60 * 1000);
    this.exportUserPoolSnapshot();
    
    logger.info('Bot started - monitoring for opportunities');
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
    this.inFlightLiquidations.clear();
    this.isCheckingUsers = false;
    this.priceOracle.stopPriceMonitoring();
    logger.info('Final Statistics:', this.executor.getStats());
    logger.info('Bot stopped');
  }

  /**
   * @notice Restart bot after successful liquidation via systemd
   * @dev Gracefully stops bot and exits process, systemd will restart
   */
  async restart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }
    this.isRestarting = true;
    logger.info('Successful liquidation - restarting via systemd for fresh state...');
    await this.stop();
    logger.info('Bot stopped gracefully, exiting for systemd restart...');
    process.exit(0);
  }

  /**
   * @notice Restart bot via systemd on fatal error
   * @dev Gracefully stops and exits, systemd will restart
   */
  private async restartBot(): Promise<void> {
    if (this.isRestarting) {
      logger.warn('Restart already in progress, skipped');
      return;
    }
    this.isRestarting = true;
    logger.error('Fatal error detected - restarting via systemd...');
    await this.stop();
    logger.info('Bot stopped gracefully, exiting for systemd restart...');
    process.exit(1);
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
    const chainId = await this.publicClient.getChainId();
    const blockNumber = await this.publicClient.getBlockNumber();
    const balance = await this.publicClient.getBalance({ address: this.account.address });
    logger.info(`Connected: Base chain ${chainId}, block ${blockNumber}, balance ${formatEther(balance)} ETH`);
    if (Number(chainId) !== basePreconf.id) {
      throw new Error(`Wrong network! Expected ${basePreconf.id}, got ${chainId}`);
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
    logger.info(`Monitoring ${assetsToMonitor.length} assets: ${monitoredSymbols.join(', ')}`);
    this.priceOracle.setFatalErrorHandler(() => {
      logger.error('Fatal WebSocket error detected, initiating bot restart...');
      this.restartBot();
    });
    await this.priceOracle.startPriceMonitoring(
      assetsToMonitor,
      this.handlePriceChange.bind(this),
      config.network.wssUrl
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
    this.priceUpdateTimestamp = Date.now();
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
      const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
      logger.info(`Checking ${usersToCheck.length} affected users (elapsed: ${elapsedSincePriceUpdate}ms)`);
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
    const healthCheckStart = Date.now();
    const healthMap = await this.healthChecker.checkUsers(userAddresses);
    const healthCheckLatency = Date.now() - healthCheckStart;
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
      const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
      logger.info(`Found ${liquidatable.length} liquidatable users (health check: ${healthCheckLatency}ms, elapsed: ${elapsedSincePriceUpdate}ms)`);
      const availableUsers = liquidatable.filter(userHealth => {
        if (this.inFlightLiquidations.has(userHealth.user)) {
          logger.debug(`Skipping ${userHealth.user} - already being liquidated`);
          return false;
        }
        return true;
      });
      if (availableUsers.length === 0) {
        logger.info('All liquidatable users already in-flight, skipping');
        return;
      }
      const selection = await this.selectBestLiquidation(availableUsers);
      if (!selection) return;
      const success = await this.executeLiquidationWithParams(selection.user, selection.params, selection.gasSettings);
      if (success) await this.restart();
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
    
    // Sort by value first (best to worst)
    const validLiquidations = Array.from(paramsMap.values());
    validLiquidations.sort((a, b) => {
      const valueDiff = b.params.estimatedValue - a.params.estimatedValue;
      if (Math.abs(valueDiff) > 50) return valueDiff;
      return a.userHealth.healthFactor - b.userHealth.healthFactor;
    });
    
    // Get wallet balance once
    const balanceStart = Date.now();
    const balance = await this.publicClient.getBalance({ address: this.account.address });
    const balanceLatency = Date.now() - balanceStart;
    const balanceETH = Number(formatEther(balance));
    
    // Get base gas price once (inline calculation to avoid method overhead)
    const gasPriceStart = Date.now();
    const gasPrice = await this.executor['gasManager']['getGasPrice']();
    const gasPriceLatency = Date.now() - gasPriceStart;
    const baseFee = gasPrice;
    const fixedGasLimit = 920000n;
    
    // Find first affordable liquidation (best that we can afford)
    let skippedCount = 0;
    for (const liq of validLiquidations) {
      // Inline gas calculation (avoid method call overhead)
      const basePriorityFee = 1_000_000_000n; // 1 gwei
      const valueAbove100 = Math.max(0, liq.params.estimatedValue - 100);
      const additionalPriorityGwei = valueAbove100 * 0.01;
      const additionalPriorityWei = BigInt(Math.floor(additionalPriorityGwei * 1e9));
      const priorityFee = basePriorityFee + additionalPriorityWei;
      const maxFeePerGas = (baseFee * 110n) / 100n + priorityFee;
      const gasSettings = {
        maxFeePerGas,
        maxPriorityFeePerGas: priorityFee,
        gas: fixedGasLimit,
      };
      
      const maxGasCostWei = fixedGasLimit * gasSettings.maxFeePerGas;
      const maxGasCostETH = Number(formatEther(maxGasCostWei));
      
      if (balanceETH >= maxGasCostETH) {
        // Found best affordable liquidation
        const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
        logger.info(
          `Selected best affordable of ${validLiquidations.length} liquidations` +
          `${skippedCount > 0 ? ` (skipped ${skippedCount} higher-value due to insufficient balance)` : ''}: ` +
          `${liq.params.collateralSymbol}→${liq.params.debtSymbol} ` +
          `(HF: ${liq.userHealth.healthFactor.toFixed(4)}, value: $${liq.params.estimatedValue.toFixed(0)}, ` +
          `gas: ${maxGasCostETH.toFixed(6)} ETH, ` +
          `timing: params=${paramsLatency}ms balance=${balanceLatency}ms gasPrice=${gasPriceLatency}ms, ` +
          `elapsed: ${elapsedSincePriceUpdate}ms)`
        );
        return { user: liq.userHealth, params: liq.params, gasSettings };
      } else {
        skippedCount++;
        logger.debug(
          `Skipping #${skippedCount} ${liq.params.collateralSymbol}→${liq.params.debtSymbol} (value: $${liq.params.estimatedValue.toFixed(0)}): ` +
          `insufficient balance (have: ${balanceETH.toFixed(6)} ETH, need: ${maxGasCostETH.toFixed(6)} ETH)`
        );
      }
    }
    
    // No affordable liquidation found
    logger.warn(
      `No affordable liquidations (balance: ${balanceETH.toFixed(6)} ETH, ` +
      `all ${validLiquidations.length} opportunities need more funds)`
    );
    return null;
  }

  /**
   * @notice Export UserPool snapshot to JSON file for monitoring (async, non-blocking)
   * @dev Called periodically and can be read by external monitoring tools
   */
  private async exportUserPoolSnapshot(): Promise<void> {
    try {
      const stats = this.userPool.getStats();
      const users = this.userPool.getAllUsers();
      
      const snapshot = {
        timestamp: Date.now(),
        stats,
        users: users.map(u => ({
          address: u.address,
          collateralAssets: u.collateralAssets,
          debtAssets: u.debtAssets,
          collateralUSD: u.collateralUSD,
          debtUSD: u.debtUSD,
          lastCheckedHF: u.lastCheckedHF,
          lastUpdated: u.lastUpdated,
          addedAt: u.addedAt,
        })),
      };
      
      const snapshotPath = path.join(__dirname, '../userpool_snapshot.json');
      await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
      logger.debug(`Snapshoot createdt: ${users.length} users`);
    } catch (error) {
      logger.error('Failed to export UserPool snapshot:', error);
    }
  }

  private async executeLiquidationWithParams(
    userHealth: UserHealth,
    params: LiquidationParams,
    gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }
  ): Promise<boolean> {
    this.inFlightLiquidations.add(userHealth.user);
    try {
      const executionStart = Date.now();
      const elapsedBeforeExecution = executionStart - this.priceUpdateTimestamp;
      logger.info(`Starting execution (elapsed since price update: ${elapsedBeforeExecution}ms)`);
      
      const tx = await this.executor.executeLiquidation(
        params.collateralAsset,
        params.debtAsset,
        params.userAddress,
        params.debtToCover,
        params.estimatedValue,
        gasSettings
      );
      const executionLatency = Date.now() - executionStart;
      const totalLatency = Date.now() - this.priceUpdateTimestamp;
      if (tx.success) {
        logger.info(
          `✓ Liquidated: ${tx.txHash} | ` +
          `Execution: ${executionLatency}ms | ` +
          `Total (price→tx): ${totalLatency}ms`
        );
        return true;
      }
      return false;
    } finally {
      this.inFlightLiquidations.delete(userHealth.user);
    }
  }
}

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
