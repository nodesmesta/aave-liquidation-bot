import { createPublicClient, http, formatEther, Chain } from 'viem';
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
import { LiquidationManager } from './services/LiquidationManager';

class LiquidatorBot {
  private globalRpcClient: any;
  private globalPreconfClient: any;
  private account: ReturnType<typeof createAccount>;
  private healthChecker: HealthChecker;
  private executor: LiquidationExecutor;
  private priceOracle: PriceOracle;
  private subgraphService: SubgraphService;
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
    this.subgraphService = new SubgraphService(config.aave.subgraphUrl, this.globalRpcClient);
    this.optimizedLiquidation = new OptimizedLiquidationService(
      this.globalRpcClient,
      config.aave.protocolDataProvider
    );
    this.userPool = new UserPool();
    this.liquidationManager = new LiquidationManager(
      this.userPool,
      this.healthChecker,
      this.optimizedLiquidation,
      this.executor,
      this.globalRpcClient,
      this.account.address,
      async () => { await this.restart(); }
    );
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
      async (updates) => {
        if (!this.isInitialized || this.isRestarting) return;
        await this.liquidationManager.handlePriceChange(updates);
      },
      config.network.wssUrl
    );
    this.isPriceMonitoring = true;
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
