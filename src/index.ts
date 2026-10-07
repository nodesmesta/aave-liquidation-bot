import { createPublicClient, http, formatEther, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config, validateConfig } from './config';
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
import { AssetManager } from './services/AssetManager';
import { LiquidationParams } from './services/OptimizedLiquidationService';
import { LiquidationManager } from './services/LiquidationManager';
import { SmartRouter } from './services/SmartRouter';

class LiquidatorBot {
  private globalRpcClient: any;
  private globalPreconfClient: any;
  private account: ReturnType<typeof createAccount>;
  private healthChecker: HealthChecker;
  private executor: LiquidationExecutor;
  private priceOracle: PriceOracle;
  private subgraphService: SubgraphService;
  private assetManager: AssetManager;
  private smartRouter: SmartRouter;
  private optimizedLiquidation: OptimizedLiquidationService;
  private userPool: UserPool;
  private isInitialized = false;
  private isPriceMonitoring = false;
  private isRestarting = false;
  private liquidationManager: LiquidationManager;

  constructor() {
    const customChain: Chain = {
      ...basePreconf,
      rpcUrls: {
        ...basePreconf.rpcUrls,
        default: { http: [config.network.rpcUrl] },
      },
    } as Chain;
    this.globalRpcClient = createPublicClient({
      chain: customChain,
      transport: http(config.network.rpcUrl),
    });
    this.globalPreconfClient = createPublicClient({
      chain: basePreconf,
      transport: http(config.network.preconfUrl),
    });
    this.account = createAccount();
    this.healthChecker = new HealthChecker(this.globalRpcClient, config.aave.pool);
    this.executor = new LiquidationExecutor(
      this.globalRpcClient,
      this.globalPreconfClient,
      this.account
    );
    this.priceOracle = new PriceOracle(this.globalRpcClient);
    this.assetManager = new AssetManager(
      this.globalRpcClient,
      config.aave.protocolDataProvider
    );
    this.subgraphService = new SubgraphService(config.aave.subgraphUrl, this.globalRpcClient, this.assetManager);
    this.smartRouter = new SmartRouter(
      this.globalRpcClient,
      config.uniswap.quoterV2,
      this.assetManager
    );
    this.optimizedLiquidation = new OptimizedLiquidationService(
      this.globalRpcClient,
      config.aave.protocolDataProvider,
      this.assetManager,
      this.smartRouter
    );
    this.userPool = new UserPool();
    this.liquidationManager = new LiquidationManager(
      this.userPool,
      this.healthChecker,
      this.optimizedLiquidation,
      this.executor,
      this.globalRpcClient,
      this.account.address,
      this.assetManager,
      async (liquidatedUser: string) => { await this.handleLiquidationSuccess(liquidatedUser); }
    );
  }

  /**
   * @notice Initialize user pool from Subgraph and on-chain validation
   * @dev Queries USDC borrowers, validates HF < 1.075
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing bot (strategy: USDC debt, HF < 1.075)...');
      await this.executor.initialize();
      await this.assetManager.initialize();
      this.assetManager.startEventListening(this.priceOracle);
      const candidatesMap = await this.subgraphService.getActiveBorrowers();
      if (candidatesMap.size === 0) {
        logger.warn('No candidates found from subgraph');
        this.isInitialized = true;
        return;
      }
      const userAddresses = Array.from(candidatesMap.keys());
      const validationResults = await this.subgraphService.validateUsersOnChain(
        userAddresses,
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
        this.userPool.addUser({
          address: address,
          estimatedHF: data.hf,
          collateralUSD: data.collateral,
          debtUSD: data.debt,
          collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
          debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
          lastCheckedHF: data.hf,
          lastUpdated: Date.now(),
          addedAt: Date.now()
        });
      }
      this.userPool.logStatus();

      // Pre-warm SmartRouter route cache for active user collateral/debt pairs
      const uniquePairs = new Map<string, { tokenIn: string; tokenOut: string; sampleAmountIn: bigint }>();
      for (const [, data] of validationResults.entries()) {
        for (const c of data.collateralAssets) {
          for (const d of data.debtAssets) {
            if (c.toLowerCase() !== d.toLowerCase()) {
              const pairKey = `${c.toLowerCase()}_${d.toLowerCase()}`;
              if (!uniquePairs.has(pairKey)) {
                uniquePairs.set(pairKey, { tokenIn: c, tokenOut: d, sampleAmountIn: 1000000n });
              }
            }
          }
        }
      }
      if (uniquePairs.size > 0) {
        await this.smartRouter.prewarmRoutes(Array.from(uniquePairs.values()));
        this.smartRouter.startPeriodicRefresh(() => Array.from(uniquePairs.values()), 5 * 60 * 1000);
      }

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
    
    // Background Job: Discovery & Pruning every 6 hours
    setInterval(() => {
      this.startBackgroundSync();
    }, 6 * 60 * 60 * 1000);
    
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
    this.priceOracle.stopPriceMonitoring();
    logger.info('Final Statistics:', this.executor.getStats());
    logger.info('Bot stopped');
  }

  /**
   * @notice Handle state synchronization after successful liquidation without restart
   * @dev Updates liquidated user status, and checks watched candidates (1.075 <= HF <= 1.15)
   */
  private async handleLiquidationSuccess(liquidatedUser: string): Promise<void> {
    logger.info(`Handling post-liquidation sync for user: ${liquidatedUser}`);
    try {
      // 1. Sync user yang baru saja dilikuidasi
      const health = await this.healthChecker.checkUser(liquidatedUser);
      if (health.healthFactor >= 1.1 || health.totalDebtBase === 0n) {
        this.userPool.removeUser(liquidatedUser);
        logger.info(`Post-liquidation: User ${liquidatedUser} removed from pool (HF: ${health.healthFactor.toFixed(4)})`);
        if (health.healthFactor < 1.15 && health.totalDebtBase > 0n) {
          this.subgraphService.getWatchedCandidates().add(liquidatedUser.toLowerCase());
        }
      } else {
        this.userPool.updateUserHF(liquidatedUser, health.healthFactor);
        logger.info(`Post-liquidation: User ${liquidatedUser} updated in pool (new HF: ${health.healthFactor.toFixed(4)})`);
      }

      // 2. Cek watched candidates (1.075 <= HF <= 1.15) jika ada pergerakan pasar
      const watched = this.subgraphService.getWatchedCandidates();
      if (watched.size > 0) {
        const watchedList = Array.from(watched);
        logger.info(`Checking ${watchedList.length} watched candidates (1.075 <= HF <= 1.15) for risk escalation...`);
        const healthMap = await this.healthChecker.checkUsers(watchedList);
        const escalatedUsers: string[] = [];
        for (const [addr, h] of healthMap.entries()) {
          if (h.healthFactor < 1.075 && h.totalDebtBase > 0n) {
            escalatedUsers.push(addr);
          } else if (h.healthFactor >= 1.15 || h.totalDebtBase === 0n) {
            watched.delete(addr);
          }
        }

        if (escalatedUsers.length > 0) {
          logger.info(`Found ${escalatedUsers.length} watched candidates escalated to HF < 1.075! Ingesting...`);
          const validationResults = await this.subgraphService.validateUsersOnChain(
            escalatedUsers,
            config.aave.pool,
            config.aave.protocolDataProvider
          );
          for (const [address, data] of validationResults.entries()) {
            this.userPool.addUser({
              address: address,
              estimatedHF: data.hf,
              collateralUSD: data.collateral,
              debtUSD: data.debt,
              collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
              debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
              lastCheckedHF: data.hf,
              lastUpdated: Date.now(),
              addedAt: Date.now()
            });
          }
          this.userPool.logStatus();
        }
      }
    } catch (error) {
      logger.error('Error during post-liquidation sync:', error);
    }
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
   * @notice Verify RPC connection and network
   * @dev Checks network ID matches config, logs block number and wallet balance
   */
  private async checkConnection(): Promise<void> {
    const chainId = await this.globalRpcClient.getChainId();
    const blockNumber = await this.globalRpcClient.getBlockNumber();
    const balance = await this.globalRpcClient.getBalance({ address: this.account.address });
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
    const assetsToMonitor = this.assetManager.getAddressesToMonitor();
    if (assetsToMonitor.length === 0) {
      logger.warn('No volatile assets to monitor (AssetManager not initialized yet)');
      return;
    }
    logger.info(`Monitoring ${assetsToMonitor.length} assets`);
    this.priceOracle.setFatalErrorHandler(() => {
      logger.error('Fatal WebSocket error detected, initiating bot restart...');
      this.restartBot();
    });
    await this.priceOracle.startPriceMonitoring(
      assetsToMonitor,
      async (updates) => {
        if (!this.isInitialized || this.isRestarting) return;
        await this.liquidationManager.handlePriceChange(updates);
      },
      config.network.wssUrl
    );
    this.isPriceMonitoring = true;
  }



  /**
   * @notice Background job for dynamic user discovery and pruning
   * @dev Runs periodically to find new borrowers and prune safe ones
   */
  private async startBackgroundSync(): Promise<void> {
    if (!this.isInitialized || this.isRestarting) return;
    logger.info('Starting background sync (Discovery & Pruning)...');
    try {
      const allTrackedUsers = this.userPool.getAllUsers().map(u => u.address);
      if (allTrackedUsers.length > 0) {
        logger.info(`Pruning: Validating ${allTrackedUsers.length} existing users...`);
        const healthMap = await this.healthChecker.checkUsers(allTrackedUsers);
        let pruned = 0;
        for (const [address, health] of healthMap.entries()) {
          if (health.healthFactor >= 1.1 || health.totalDebtBase === 0n) {
            this.userPool.removeUser(address);
            pruned++;
            if (health.healthFactor < 1.15 && health.totalDebtBase > 0n) {
              this.subgraphService.getWatchedCandidates().add(address.toLowerCase());
            }
          } else {
            this.userPool.updateUserHF(address, health.healthFactor);
          }
        }
        logger.info(`Pruning complete: Removed ${pruned} safe/repaid users.`);
      }

      logger.info('Discovery: Querying subgraph for new active borrowers...');
      const candidatesMap = await this.subgraphService.getActiveBorrowers();
      const newAddresses = Array.from(candidatesMap.keys()).filter(addr => 
        !allTrackedUsers.includes(addr.toLowerCase())
      );
      
      if (newAddresses.length > 0) {
        logger.info(`Discovery: Found ${newAddresses.length} new candidates to validate.`);
        const validationResults = await this.subgraphService.validateUsersOnChain(
          newAddresses,
          config.aave.pool,
          config.aave.protocolDataProvider
        );
        let added = 0;
        for (const [address, data] of validationResults.entries()) {
          this.userPool.addUser({
            address: address,
            estimatedHF: data.hf,
            collateralUSD: data.collateral,
            debtUSD: data.debt,
            collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
            debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
            lastCheckedHF: data.hf,
            lastUpdated: Date.now(),
            addedAt: Date.now()
          });
          added++;
        }
        logger.info(`Discovery complete: Added ${added} new at-risk users to pool.`);
      } else {
        logger.info('Discovery complete: No new candidates found.');
      }
      this.userPool.logStatus();
    } catch (error) {
      logger.error('Error during background sync:', error);
    }
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
