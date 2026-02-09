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
      this.account
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
      await this.optimizedLiquidation.warmupConfigCache();
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
      return;
    }
    this.isRestarting = true;
    logger.error('Fatal error detected - restarting via systemd...');
    await this.stop();
    logger.info('Bot stopped gracefully, exiting for systemd restart...');
    process.exit(1);
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
   * @dev Optimized: Check high-risk users (HF <= 1.03) first, then update cache for all affected
   * @param updates Array of price updates from Chainlink
   */
  private async handlePriceChange(updates: PriceUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    if (!this.isInitialized || this.isRestarting) return;
    this.priceUpdateTimestamp = Date.now();
    const highRiskUsers = new Set<string>();
    const allAffectedUsers = new Set<string>();
    for (const update of updates) {
      const assetSymbol = getAssetSymbol(update.asset);
      const usersWithCollateral = this.userPool.getUsersWithCollateral(assetSymbol);
      const usersWithDebt = this.userPool.getUsersWithDebt(assetSymbol);
      const highRiskCollateral = usersWithCollateral.filter(u => u.lastCheckedHF <= 1.03);
      const highRiskDebt = usersWithDebt.filter(u => u.lastCheckedHF <= 1.03);
      highRiskCollateral.forEach(user => highRiskUsers.add(user.address));
      highRiskDebt.forEach(user => highRiskUsers.add(user.address));
      usersWithCollateral.forEach(user => allAffectedUsers.add(user.address));
      usersWithDebt.forEach(user => allAffectedUsers.add(user.address));
      const totalAffected = allAffectedUsers.size;
      const highRiskCount = highRiskUsers.size;
      if (totalAffected > 0) {
        logger.info(
          `${assetSymbol} ${update.percentChange > 0 ? '↑' : '↓'}${Math.abs(update.percentChange).toFixed(2)}% ` +
          `($${update.oldPrice.toFixed(2)} → $${update.newPrice.toFixed(2)}) affects ` +
          `${totalAffected} users (${highRiskCount} high-risk HF<=1.03, ${totalAffected - highRiskCount} others)`
        );
      }
    }
    if (!this.isCheckingUsers && highRiskUsers.size > 0) {
      this.checkHighRiskThenUpdateCache(Array.from(highRiskUsers), Array.from(allAffectedUsers));
    }
  }

  /**
   * @notice Check high-risk users first, execute if liquidatable, otherwise update cache for all affected
   * @dev Two-phase strategy: fast path for liquidation, slow path for cache updates
   * @param highRiskUsers Users with HF <= 1.03 to check first
   * @param allAffectedUsers All users affected by price change for cache update
   */
  private async checkHighRiskThenUpdateCache(highRiskUsers: string[], allAffectedUsers: string[]): Promise<void> {
    if (this.isCheckingUsers) return;
    if (!this.isInitialized || this.isRestarting) return;
    this.isCheckingUsers = true;
    try {
      const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
      logger.info(`Phase 1: Checking ${highRiskUsers.length} high-risk users (HF<=1.03) for liquidation (elapsed: ${elapsedSincePriceUpdate}ms)`);
      const highRiskCheckStart = Date.now();
      const highRiskHealthMap = await this.healthChecker.checkUsers(highRiskUsers);
      const highRiskCheckLatency = Date.now() - highRiskCheckStart;
      const liquidatable = this.healthChecker.filterLiquidatable(highRiskHealthMap);
      if (liquidatable.length > 0) {
        const elapsedAfterCheck = Date.now() - this.priceUpdateTimestamp;
        logger.info(`Found ${liquidatable.length} liquidatable users in high-risk check (check: ${highRiskCheckLatency}ms, elapsed: ${elapsedAfterCheck}ms)`);
        const availableUsers = liquidatable.filter(userHealth => !this.inFlightLiquidations.has(userHealth.user));
        if (availableUsers.length > 0) {
          const selection = await this.selectBestLiquidation(availableUsers);
          if (selection) {
            const success = await this.executeLiquidationWithParams(selection.user, selection.params, selection.gasSettings);
            if (success) await this.restart();
            return;
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
      const totalElapsed = Date.now() - this.priceUpdateTimestamp;
      logger.info(`Cache updated (${removedCount} removed, check: ${cacheUpdateLatency}ms, total elapsed: ${totalElapsed}ms)`);
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
    
    const balanceStart = Date.now();
    const balance = await this.publicClient.getBalance({ address: this.account.address });
    const balanceLatency = Date.now() - balanceStart;
    const balanceETH = Number(formatEther(balance));
    const fixedGasLimit = 920000n;
    const gasPrice = await this.executor['gasManager'].getGasPrice();
    let skippedCount = 0;
    for (const liq of validLiquidations) {
      const gasSettings = this.executor['gasManager'].calculateGasSettings(
        gasPrice,
        fixedGasLimit,
        liq.params.estimatedValue
      );
      const maxGasCostWei = fixedGasLimit * gasSettings.maxFeePerGas;
      const maxGasCostETH = Number(formatEther(maxGasCostWei));
      if (balanceETH >= maxGasCostETH) {
        const elapsedSincePriceUpdate = Date.now() - this.priceUpdateTimestamp;
        logger.info(
          `Selected best affordable of ${validLiquidations.length} liquidations` +
          `${skippedCount > 0 ? ` (skipped ${skippedCount} higher-value due to insufficient balance)` : ''}: ` +
          `${liq.params.collateralSymbol}→${liq.params.debtSymbol} ` +
          `(HF: ${liq.userHealth.healthFactor.toFixed(4)}, value: $${liq.params.estimatedValue.toFixed(0)}, ` +
          `gas: ${maxGasCostETH.toFixed(6)} ETH, ` +
          `timing: params=${paramsLatency}ms balance=${balanceLatency}ms, ` +
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
