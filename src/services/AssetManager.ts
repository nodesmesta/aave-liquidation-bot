import { Address, PublicClient, parseAbi, createPublicClient, webSocket } from 'viem';
import { base } from 'viem/chains';
import { AaveV3Base } from '@bgd-labs/aave-address-book';
import { logger } from '../utils/logger';
import { config } from '../config';
import { PriceOracle } from './PriceOracle';

export interface AssetConfig {
  decimals: number;
  liquidationBonus: number;
  liquidationProtocolFee: number;
  /** Raw liquidation bonus in bps (e.g. 10500 = 5% bonus). Use this for exact math. */
  liquidationBonusBps: number;
  /** Raw liquidation protocol fee in bps (e.g. 1000 = 10% of the bonus). */
  liquidationProtocolFeeBps: number;
  symbol: string;
  /** Reserve id in the Aave Pool bitmap. Must be stored explicitly: deriving it from the
   *  position inside a filtered map silently shifts every index when one config call fails. */
  reserveId: number;
  ltv: number;
  liquidationThreshold: number;
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
}

export class AssetManager {
  private publicClient: PublicClient;
  private wsClient: any = null;
  private protocolDataProvider: Address;
  private oracleAddress: Address;

  // Memori Penyimpanan Terpusat (Central Cache)
  private assetConfigs: Map<string, AssetConfig> = new Map();
  private addressesToMonitor: string[] = []; // Aset yang memiliki oracle (price feed) valid
  /** Index-aligned reserve list: position == Aave reserve id. `null` marks a reserve whose
   *  configuration could not be fetched, so ids never shift. */
  private reservesByIndex: Array<{ symbol: string; address: string } | null> = [];

  // ABI untuk fetching data Aave
  private reservesTokensAbi = [
    {
      name: 'getAllReservesTokens',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        {
          name: '',
          type: 'tuple[]',
          components: [
            { name: 'symbol', type: 'string' },
            { name: 'tokenAddress', type: 'address' }
          ]
        }
      ]
    }
  ] as const;

  private dataProviderAbi = parseAbi([
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
    'function getLiquidationProtocolFee(address asset) external view returns (uint256)'
  ]);

  private oracleAbi = parseAbi([
    'function getSourceOfAsset(address asset) external view returns (address)'
  ]);

  private configuratorEventsAbi = parseAbi([
    'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
    'event ReservePaused(address indexed asset, bool isPaused)',
    'event CollateralConfigurationChanged(address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)'
  ]);

  constructor(publicClient: any, protocolDataProvider: string, wsClient?: any) {
    this.publicClient = publicClient;
    this.protocolDataProvider = protocolDataProvider as Address;
    this.oracleAddress = config.aave.oracle as Address;
    if (wsClient) {
      this.wsClient = wsClient;
    }
  }

  /**
   * @notice Inisialisasi awal untuk menarik seluruh data aset dari Aave.
   * Dipanggil secara dinamis saat bot menyala (startup).
   */
  async initialize(): Promise<void> {
    logger.info('Initializing AssetManager (Fetching active reserves from Aave)...');
    
    // 1. Tarik seluruh daftar alamat aset dari kontrak
    const reserves = await this.publicClient.readContract({
      address: this.protocolDataProvider,
      abi: this.reservesTokensAbi,
      functionName: 'getAllReservesTokens',
    }) as Array<{ symbol: string; tokenAddress: string }>;

    // 2. Persiapkan pemanggilan Multicall (Batch) untuk efisiensi RPC
    const configContracts = reserves.map(r => ({
      address: this.protocolDataProvider,
      abi: this.dataProviderAbi,
      functionName: 'getReserveConfigurationData',
      args: [r.tokenAddress as Address],
    }));

    const oracleContracts = reserves.map(r => ({
      address: this.oracleAddress,
      abi: this.oracleAbi,
      functionName: 'getSourceOfAsset',
      args: [r.tokenAddress as Address],
    }));

    const protocolFeeContracts = reserves.map(r => ({
      address: this.protocolDataProvider,
      abi: this.dataProviderAbi,
      functionName: 'getLiquidationProtocolFee',
      args: [r.tokenAddress as Address],
    }));

    // Eksekusi secara paralel
    const [configResults, oracleResults, protocolFeeResults] = await Promise.all([
      this.publicClient.multicall({ contracts: configContracts }),
      this.publicClient.multicall({ contracts: oracleContracts }),
      this.publicClient.multicall({ contracts: protocolFeeContracts })
    ]);

    this.assetConfigs.clear();
    this.addressesToMonitor = [];
    this.reservesByIndex = new Array(reserves.length).fill(null);

    // 3. Olah hasil balasan RPC dan simpan ke memori lokal
    for (let i = 0; i < reserves.length; i++) {
      const reserve = reserves[i];
      const address = reserve.tokenAddress.toLowerCase();
      const configRes = configResults[i];
      const oracleRes = oracleResults[i];
      const protocolFeeRes = protocolFeeResults[i];

      // Memproses desimal dan bonus likuidasi
      if (configRes.status === 'success') {
        const data = configRes.result as readonly any[];
        const decimals = Number(data[0]);
        const ltv = Number(data[1]);
        const liquidationThreshold = Number(data[2]);
        const liquidationBonusRaw = Number(data[3]);
        // Konversi format Aave V3: 10500 berarti bonus 5%
        const liquidationBonus = liquidationBonusRaw > 0 ? (liquidationBonusRaw - 10000) / 100 : 0;
        const usageAsCollateralEnabled = Boolean(data[5]);
        const borrowingEnabled = Boolean(data[6]);
        const isActive = Boolean(data[8]);
        const isFrozen = Boolean(data[9]);

        // Liquidation protocol fee: bps dari porsi bonus (mis. 1000 = 10%)
        const protocolFeeRaw = protocolFeeRes.status === 'success' ? Number(protocolFeeRes.result) : 0;
        const liquidationProtocolFee = protocolFeeRaw / 100;

        this.assetConfigs.set(address, {
          symbol: reserve.symbol,
          decimals,
          liquidationBonus,
          liquidationProtocolFee,
          liquidationBonusBps: liquidationBonusRaw,
          liquidationProtocolFeeBps: protocolFeeRaw,
          reserveId: i,
          ltv,
          liquidationThreshold,
          usageAsCollateralEnabled,
          borrowingEnabled,
          isActive,
          isFrozen,
          isPaused: false,
        });
        this.reservesByIndex[i] = { symbol: reserve.symbol, address };
      } else {
        logger.warn(`AssetManager: getReserveConfigurationData failed for ${reserve.symbol} (${address}) - reserve id ${i} left as a hole to keep ids aligned`);
      }

      // Memvalidasi dukungan Chainlink Oracle
      if (oracleRes.status === 'success') {
        const sourceAddress = oracleRes.result as string;
        // Jika bukan 0x00... maka aset ini dapat dipantau harganya
        if (sourceAddress && sourceAddress !== '0x0000000000000000000000000000000000000000') {
          this.addressesToMonitor.push(address);
        }
      }
    }

    logger.info(`AssetManager Initialized: ${this.assetConfigs.size} aset tersimpan, ${this.addressesToMonitor.length} aset terpantau (valid oracle).`);
  }

  // --- Helper & Getter Methods ---

  public getAllReserves(): Array<{ symbol: string; address: string }> {
    const result: Array<{ symbol: string; address: string }> = [];
    for (const [address, config] of this.assetConfigs.entries()) {
      result.push({ symbol: config.symbol, address });
    }
    return result;
  }

  /**
   * @notice Get the reserve list indexed by Aave reserve id
   * @dev Position in the returned array IS the reserve id. Entries are `null` when the reserve
   *      configuration could not be fetched, so callers must null-check instead of assuming
   *      that a filtered list keeps the original ordering.
   * @return Index-aligned reserve list
   */
  public getReservesByIndex(): Array<{ symbol: string; address: string } | null> {
    return this.reservesByIndex;
  }

  /**
   * @notice Resolve a reserve id to its address
   * @param reserveId Aave reserve id (bitmap position)
   * @return Reserve address, or undefined when the id is unknown / config fetch failed
   */
  public getReserveAddressById(reserveId: number): string | undefined {
    return this.reservesByIndex[reserveId]?.address;
  }

  /**
   * @notice Check whether a reserve can currently be used as liquidation collateral
   * @dev Mirrors the on-chain guards that make `liquidationCall` revert: inactive, frozen or
   *      paused reserves cannot be seized. Checking off-chain avoids burning gas on a revert.
   * @param address Reserve underlying address
   * @return True when the reserve is active, not frozen and not paused
   */
  public isReserveLiquidatable(address: string): boolean {
    const config = this.assetConfigs.get(address.toLowerCase());
    if (!config) return false;
    return config.isActive && !config.isFrozen && !config.isPaused;
  }

  public getSymbol(address: string): string {
    const normalized = address.toLowerCase();
    return this.assetConfigs.get(normalized)?.symbol || address;
  }

  public getAssetConfig(address: string): AssetConfig | undefined {
    const normalized = address.toLowerCase();
    return this.assetConfigs.get(normalized);
  }

  public getAddressesToMonitor(): string[] {
    return this.addressesToMonitor;
  }

  /**
   * @notice Mendapatkan alamat token hub likuiditas utama (WETH, USDC, cbBTC) dari aset aktif Aave
   */
  public getRoutingHubs(): Address[] {
    const hubSymbols = new Set(['WETH', 'USDC', 'CBBTC']);
    const hubs: Address[] = [];
    for (const [address, config] of this.assetConfigs.entries()) {
      if (hubSymbols.has(config.symbol.toUpperCase())) {
        hubs.push(address as Address);
      }
    }
    return hubs;
  }

  /**
   * @notice Mengaktifkan event listener pada kontrak Aave PoolConfigurator via WebSocket.
   * @dev Menggunakan WebSocket untuk event streaming real-time tanpa HTTP RPC polling.
   * @param priceOracle Referensi PriceOracle untuk sinkronisasi subscription harga otomatis.
   * @param customWsClient Opsional instance PublicClient dengan WebSocket transport.
   */
  public startEventListening(priceOracle?: PriceOracle, customWsClient?: any): void {
    if (customWsClient) {
      this.wsClient = customWsClient;
    } else if (!this.wsClient && config.network.wssUrl) {
      this.wsClient = createPublicClient({
        chain: base,
        transport: webSocket(config.network.wssUrl, {
          keepAlive: true,
          reconnect: true,
        }),
      });
      logger.info('AssetManager: WebSocket client initialized');
    }

    const clientToUse = this.wsClient || this.publicClient;
    const transportType = this.wsClient ? 'WebSocket' : 'HTTP (fallback)';
    logger.info(`Starting Aave PoolConfigurator Event Listener via ${transportType}...`);

    // 1. ReserveInitialized (Saat koin baru didaftarkan ke Aave)
    clientToUse.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'ReserveInitialized',
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          const assetAddress = log.args.asset;
          if (assetAddress) {
            logger.info(`[Event] New Reserve Initialized: ${assetAddress}. Re-syncing cache...`);
            await this.initialize();
            // Instruksikan PriceOracle untuk mulai memantau harga aset baru ini.
            await priceOracle?.addAsset(assetAddress.toLowerCase());
          }
        }
      },
      onError: (error: any) => {
        logger.error(`AssetManager WebSocket error (ReserveInitialized): ${error?.message || error}`);
      }
    });

    // 2. ReservePaused (Saat fitur borrow/collateral koin dibekukan Aave)
    clientToUse.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'ReservePaused',
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          const assetAddress = log.args.asset?.toLowerCase();
          const isPaused = log.args.isPaused;
          if (assetAddress && isPaused) {
            logger.info(`[Event] Reserve Paused: ${assetAddress}. Removing from monitor.`);
            this.addressesToMonitor = this.addressesToMonitor.filter(a => a !== assetAddress);
            const pausedConfig = this.assetConfigs.get(assetAddress);
            if (pausedConfig) {
              this.assetConfigs.set(assetAddress, { ...pausedConfig, isPaused: true });
            }
            // Instruksikan PriceOracle untuk berhenti memantau harga aset yang dibekukan.
            priceOracle?.removeAsset(assetAddress);
          } else if (assetAddress && !isPaused) {
            logger.info(`[Event] Reserve Unpaused: ${assetAddress}. Re-syncing cache...`);
            await this.initialize();
            // Instruksikan PriceOracle untuk kembali memantau harga aset yang diaktifkan.
            await priceOracle?.addAsset(assetAddress);
          }
        }
      },
      onError: (error: any) => {
        logger.error(`AssetManager WebSocket error (ReservePaused): ${error?.message || error}`);
      }
    });

    // 3. CollateralConfigurationChanged (Saat Aave mengubah angka Liquidation Bonus / LTV)
    // Tidak ada interaksi dengan PriceOracle karena event ini hanya mengubah parameter kalkulasi.
    clientToUse.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'CollateralConfigurationChanged',
      onLogs: (logs: any[]) => {
        for (const log of logs) {
          const assetAddress = log.args.asset?.toLowerCase();
          const liquidationBonusRaw = Number(log.args.liquidationBonus);
          
          if (assetAddress && liquidationBonusRaw) {
            const newBonus = liquidationBonusRaw > 0 ? (liquidationBonusRaw - 10000) / 100 : 0;
            const existingConfig = this.assetConfigs.get(assetAddress);
            if (existingConfig) {
              logger.info(`[Event] Collateral Config Changed for ${assetAddress}. New Bonus: ${newBonus}%`);
              this.assetConfigs.set(assetAddress, {
                ...existingConfig,
                liquidationBonus: newBonus
              });
            }
          }
        }
      },
      onError: (error: any) => {
        logger.error(`AssetManager WebSocket error (CollateralConfigurationChanged): ${error?.message || error}`);
      }
    });
  }
}
