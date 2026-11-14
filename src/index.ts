import { createPublicClient, http, formatEther } from 'viem';
import { base, basePreconf } from 'viem/chains';
import { config, validateConfig } from './config';
import { HF, hfRawToNumber, isPoolTierRaw, shouldPruneRaw, formatHF } from './config/thresholds';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './utils/logger';
import { createAccount } from './utils/wallet';
import { HealthChecker } from './services/HealthChecker';
import { LiquidationExecutor } from './services/LiquidationExecutor';
import { PriceOracle } from './services/PriceOracle';
import { SubgraphService } from './services/SubgraphService';
import { OptimizedLiquidationService } from './services/OptimizedLiquidationService';
import { AssetManager } from './services/AssetManager';
import { LiquidationManager } from './services/LiquidationManager';
import { SmartRouter } from './services/SmartRouter';
import { UserPool, UserTier } from './services/UserPool';

const DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
const SNAPSHOT_PATH = path.join(__dirname, '../userpool_snapshot.json');

interface SnapshotUser {
  address: string;
  tier?: UserTier;
  collateralAssets?: string[];
  debtAssets?: string[];
  collateralUSD?: number;
  debtUSD?: number;
  collateralUSDByAsset?: Record<string, number>;
  debtUSDByAsset?: Record<string, number>;
  liquidationThresholdRatio?: number;
  estimatedHF?: number;
  lastCheckedHF?: number;
  lastCheckedHFRaw?: string;
  lastUpdated?: number;
  addedAt?: number;
}

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
  private isExportingSnapshot = false;
  private liquidationManager: LiquidationManager;

  constructor() {
    this.globalRpcClient = createPublicClient({
      chain: base,
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
   * @notice Hydrate the user pool from Subgraph + on-chain validation
   * @dev Runs in the background after monitoring is live; never blocks startup.
   *      Populates both tiers: POOL (HF < 1.075) and WATCH (1.075 <= HF < 1.15).
   */
  async initialize(): Promise<void> {
    const startedAt = Date.now();
    logger.info('Hydrating user pool (discovery + on-chain validation)...');
    const candidatesMap = await this.subgraphService.getActiveBorrowers();
    if (candidatesMap.size === 0) {
      logger.warn('No candidates found from subgraph');
      return;
    }
    const { atRisk, watched } = await this.subgraphService.validateUsersOnChain(
      candidatesMap,
      config.aave.pool,
      config.aave.protocolDataProvider
    );
    let addedPool = 0;
    let addedWatch = 0;
    for (const [address, data] of atRisk.entries()) {
      this.userPool.addUser({
        address,
        tier: 'POOL',
        estimatedHF: data.hf,
        collateralUSD: data.collateral,
        debtUSD: data.debt,
        collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
        debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
        collateralUSDByAsset: data.collateralUSDByAsset ?? {},
        debtUSDByAsset: data.debtUSDByAsset ?? {},
        liquidationThresholdRatio: Number(data.liquidationThresholdBps) / 10000,
        lastCheckedHFRaw: data.hfRaw,
        lastCheckedHF: data.hf,
        lastUpdated: Date.now(),
        addedAt: Date.now()
      });
      addedPool++;
    }
    for (const [address, data] of watched.entries()) {
      this.userPool.addUser({
        address,
        tier: 'WATCH',
        estimatedHF: data.hf,
        collateralUSD: data.collateral,
        debtUSD: data.debt,
        collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
        debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
        collateralUSDByAsset: data.collateralUSDByAsset ?? {},
        debtUSDByAsset: data.debtUSDByAsset ?? {},
        liquidationThresholdRatio: Number(data.liquidationThresholdBps) / 10000,
        lastCheckedHFRaw: data.hfRaw,
        lastCheckedHF: data.hf,
        lastUpdated: Date.now(),
        addedAt: Date.now()
      });
      addedWatch++;
    }
    logger.info(`Hydration complete in ${Date.now() - startedAt}ms: ${addedPool} POOL / ${addedWatch} WATCH (${candidatesMap.size} candidates scanned)`);
    this.userPool.logStatus();
  }

  /**
   * @notice Start liquidation bot
   * @dev Order matters: cheap warmup -> restore last pool -> price monitoring -> background hydration.
   *      Any execution is re-verified on-chain, so a restored (stale) HF only affects which users get
   *      checked first, never whether a liquidation is sent.
   */
  async start(): Promise<void> {
    logger.info('Starting liquidation bot...');
    validateConfig();
    logger.info(`Wallet: ${this.account.address}`);
    await this.checkConnection();

    // 1. Warmup that does not depend on user discovery (~1s)
    await this.executor.initialize();
    await this.assetManager.initialize();
    this.assetManager.startEventListening(this.priceOracle);

    // 2. Restore the last known pool so monitoring starts immediately after a restart
    const restored = await this.restoreUserPoolSnapshot();
    this.isInitialized = true;

    // 3. Real-time price monitoring (this used to wait for a full 145s subgraph scan)
    await this.ensurePriceMonitoring();
    await this.exportUserPoolSnapshot();
    logger.info(`Bot started - monitoring live (${restored} users restored from snapshot, pool hydration running in background)`);

    // 4. Full discovery in the background, then periodic refresh
    void this.initialize().catch((error) => logger.error('Background hydration failed:', error));
    setInterval(() => {
      void this.startBackgroundSync().catch((error) => logger.error('Background sync failed:', error));
    }, DISCOVERY_INTERVAL_MS);

    // 5. No periodic HF sweep. Health-factor detection is driven exclusively by Chainlink
    //    price events: every event resolves the exposed users from the pool indexes and then
    //    verifies each of them on-chain. A timer-based sweep would re-introduce a second,
    //    independent detection path that the event pipeline already covers.

    // Heartbeat & UserPool snapshot export
    setInterval(() => {
      void this.exportUserPoolSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  /**
   * @notice Restore the tracked pool from the last exported snapshot
   * @dev Makes cold start ~1s instead of ~145s. Cached HF is intentionally accepted: every execution
   *      path re-reads getUserAccountData before sending a transaction.
   * @return Number of users restored (0 when there is no usable snapshot)
   */
  private async restoreUserPoolSnapshot(): Promise<number> {
    try {
      const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
      const parsed = JSON.parse(raw) as { timestamp?: number; users?: SnapshotUser[] };
      if (!parsed || !Array.isArray(parsed.users)) {
        logger.warn('Snapshot has no user list, ignoring it');
        return 0;
      }
      let restored = 0;
      for (const u of parsed.users) {
        if (!u?.address || !/^0x[0-9a-fA-F]{40}$/.test(u.address)) continue;
        // Prefer the raw bigint HF; fall back to the decimal mirror for older snapshots.
        const hfRaw = typeof u.lastCheckedHFRaw === 'string' && /^\d+$/.test(u.lastCheckedHFRaw)
          ? BigInt(u.lastCheckedHFRaw)
          : BigInt(Math.round((typeof u.lastCheckedHF === 'number' ? u.lastCheckedHF : (u.estimatedHF ?? 1.2)) * 1e18));
        const hf = hfRawToNumber(hfRaw);
        const tier: UserTier = u.tier === 'WATCH' || (u.tier !== 'POOL' && !isPoolTierRaw(hfRaw)) ? 'WATCH' : 'POOL';
        this.userPool.addUser({
          address: u.address,
          tier,
          collateralAssets: (u.collateralAssets ?? []).map(a => a.toLowerCase()),
          debtAssets: (u.debtAssets ?? []).map(a => a.toLowerCase()),
          collateralUSD: typeof u.collateralUSD === 'number' ? u.collateralUSD : 0,
          debtUSD: typeof u.debtUSD === 'number' ? u.debtUSD : 0,
          collateralUSDByAsset: u.collateralUSDByAsset ?? {},
          debtUSDByAsset: u.debtUSDByAsset ?? {},
          liquidationThresholdRatio: typeof u.liquidationThresholdRatio === 'number' ? u.liquidationThresholdRatio : 0,
          estimatedHF: typeof u.estimatedHF === 'number' ? u.estimatedHF : hf,
          lastCheckedHFRaw: hfRaw,
          lastCheckedHF: hf,
          lastUpdated: typeof u.lastUpdated === 'number' ? u.lastUpdated : Date.now(),
          addedAt: typeof u.addedAt === 'number' ? u.addedAt : Date.now(),
        });
        restored++;
      }
      const ageMin = typeof parsed.timestamp === 'number' ? Math.round((Date.now() - parsed.timestamp) / 60000) : -1;
      logger.info(`Restored ${restored} users from snapshot (age ${ageMin} min) - cached HF will be re-verified on-chain before execution`);
      return restored;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        logger.info('No snapshot found - monitoring starts with an empty pool until hydration completes');
      } else {
        logger.warn('Failed to restore snapshot, continuing with an empty pool:', error);
      }
      return 0;
    }
  }


  /**
   * @notice Handle state synchronization after successful liquidation without restart
   * @dev Re-reads the liquidated user on-chain and re-tiers it. No global sweep here: watched users
   *      are now part of UserPool and are re-evaluated by the price-change handler, so a liquidation
   *      no longer blocks the pipeline.
   */
  private async handleLiquidationSuccess(liquidatedUser: string): Promise<void> {
    logger.info(`Handling post-liquidation sync for user: ${liquidatedUser}`);
    try {
      const health = await this.healthChecker.checkUser(liquidatedUser);
      if (health.totalDebtBase === 0n || shouldPruneRaw(health.healthFactorRaw)) {
        this.userPool.removeUser(liquidatedUser);
        logger.info(`Post-liquidation: User ${liquidatedUser} removed from pool (HF: ${formatHF(health.healthFactorRaw)})`);
        return;
      }
      const tier: UserTier = isPoolTierRaw(health.healthFactorRaw) ? 'POOL' : 'WATCH';
      this.userPool.setTier(liquidatedUser, tier);
      this.userPool.updateUserHF(liquidatedUser, health.healthFactorRaw, health.currentLiquidationThreshold);
      logger.info(`Post-liquidation: User ${liquidatedUser} updated (new HF: ${formatHF(health.healthFactorRaw)}, tier: ${tier})`);
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
    logger.error('Fatal error detected - exiting for systemd restart...');
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
   * @dev Prune threshold is a single HF >= 1.15 for both tiers; tier labels are refreshed from the
   *      on-chain HF, and asset composition is refreshed from the subgraph without extra RPC.
   */
  private async startBackgroundSync(): Promise<void> {
    if (!this.isInitialized || this.isRestarting) return;
    logger.info('Starting background sync (Discovery & Pruning)...');
    try {
      // 1. Re-check tracked users on-chain: prune out-of-range, keep tier labels truthful
      const trackedUsers = this.userPool.getAllUsers();
      if (trackedUsers.length > 0) {
        logger.info(`Pruning: Validating ${trackedUsers.length} tracked users...`);
        const healthMap = await this.healthChecker.checkUsers(trackedUsers.map(u => u.address));
        let pruned = 0;
        let promoted = 0;
        for (const [address, health] of healthMap.entries()) {
          const tracked = this.userPool.getUser(address);
          if (!tracked) continue;
          if (health.totalDebtBase === 0n || shouldPruneRaw(health.healthFactorRaw)) {
            this.userPool.removeUser(address);
            pruned++;
            continue;
          }
          const tier: UserTier = isPoolTierRaw(health.healthFactorRaw) ? 'POOL' : 'WATCH';
          if (tracked.tier !== tier) {
            this.userPool.setTier(address, tier);
            if (tier === 'POOL') promoted++;
          }
          this.userPool.updateUserHF(address, health.healthFactorRaw, health.currentLiquidationThreshold);
        }
        logger.info(`Pruning complete: removed ${pruned} users (HF >= ${HF.WATCH_MAX} or repaid), ${promoted} escalated to POOL.`);
      }

      // 2. Discovery: refresh composition for tracked users, validate only untracked candidates
      logger.info('Discovery: Querying subgraph for active borrowers...');
      const candidatesMap = await this.subgraphService.getActiveBorrowers();
      const trackedSet = new Set(this.userPool.getAllUsers().map(u => u.address));
      let assetsRefreshed = 0;
      for (const [address, assets] of candidatesMap.entries()) {
        if (trackedSet.has(address) && this.userPool.updateUserAssets(address, assets)) {
          assetsRefreshed++;
        }
      }
      const newCandidates = new Map(
        [...candidatesMap.entries()].filter(([address]) => !trackedSet.has(address))
      );

      if (newCandidates.size > 0) {
        logger.info(`Discovery: ${newCandidates.size} new candidates to validate (${candidatesMap.size} total).`);
        const { atRisk, watched } = await this.subgraphService.validateUsersOnChain(
          newCandidates,
          config.aave.pool,
          config.aave.protocolDataProvider
        );
        for (const [address, data] of atRisk.entries()) {
          this.userPool.addUser({
            address,
            tier: 'POOL',
            estimatedHF: data.hf,
            collateralUSD: data.collateral,
            debtUSD: data.debt,
            collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
            debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
            collateralUSDByAsset: data.collateralUSDByAsset ?? {},
            debtUSDByAsset: data.debtUSDByAsset ?? {},
            liquidationThresholdRatio: Number(data.liquidationThresholdBps) / 10000,
            lastCheckedHFRaw: data.hfRaw,
            lastCheckedHF: data.hf,
            lastUpdated: Date.now(),
            addedAt: Date.now()
          });
        }
        for (const [address, data] of watched.entries()) {
          this.userPool.addUser({
            address,
            tier: 'WATCH',
            estimatedHF: data.hf,
            collateralUSD: data.collateral,
            debtUSD: data.debt,
            collateralAssets: data.collateralAssets.map((addr: string) => addr.toLowerCase()),
            debtAssets: data.debtAssets.map((addr: string) => addr.toLowerCase()),
            collateralUSDByAsset: data.collateralUSDByAsset ?? {},
            debtUSDByAsset: data.debtUSDByAsset ?? {},
            liquidationThresholdRatio: Number(data.liquidationThresholdBps) / 10000,
            lastCheckedHFRaw: data.hfRaw,
            lastCheckedHF: data.hf,
            lastUpdated: Date.now(),
            addedAt: Date.now()
          });
        }
        logger.info(`Discovery complete: added ${atRisk.size} POOL / ${watched.size} WATCH, refreshed ${assetsRefreshed} asset lists.`);
      } else {
        logger.info(`Discovery complete: no new candidates, refreshed ${assetsRefreshed} asset lists.`);
      }
      this.userPool.logStatus();
    } catch (error) {
      logger.error('Error during background sync:', error);
    }
  }

  /**
   * @notice Export UserPool snapshot to JSON file for monitoring (async, non-blocking)
   * @dev Written atomically (temp + rename) so a reader never sees a truncated file, and a write
   *      failure degrades the export instead of crashing the process (unhandled rejection).
   */
  private async exportUserPoolSnapshot(): Promise<void> {
    if (this.isExportingSnapshot) return;
    this.isExportingSnapshot = true;
    try {
      const stats = this.userPool.getStats();
      const users = this.userPool.getAllUsers();

      const snapshot = {
        schemaVersion: 3,
        timestamp: Date.now(),
        stats,
        users: users.map(u => ({
          address: u.address,
          tier: u.tier,
          collateralAssets: u.collateralAssets,
          debtAssets: u.debtAssets,
          collateralUSD: u.collateralUSD,
          debtUSD: u.debtUSD,
          collateralUSDByAsset: u.collateralUSDByAsset,
          debtUSDByAsset: u.debtUSDByAsset,
          estimatedHF: u.estimatedHF,
          lastCheckedHF: u.lastCheckedHF,
          lastCheckedHFRaw: u.lastCheckedHFRaw.toString(),
          lastUpdated: u.lastUpdated,
          addedAt: u.addedAt,
        })),
      };

      const tmpPath = `${SNAPSHOT_PATH}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2));
      await fs.rename(tmpPath, SNAPSHOT_PATH);
      logger.info(`[Heartbeat] UserPool synced: ${users.length} users (${stats.pool} pool / ${stats.watched} watch, ${stats.critical} critical, ${stats.liquidatable} liquidatable) | TVL: $${(stats.totalCollateralUSD / 1000).toFixed(0)}K/$${(stats.totalDebtUSD / 1000).toFixed(0)}K`);
    } catch (error) {
      logger.error(`[Heartbeat] Snapshot export failed (bot keeps running):`, error);
    } finally {
      this.isExportingSnapshot = false;
    }
  }


}

async function main() {
  const bot = new LiquidatorBot();
  process.on('SIGINT', () => {
    logger.info('Received SIGINT signal, exiting...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM signal, exiting...');
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
