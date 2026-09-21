import { Address, PublicClient, parseAbi } from 'viem';
import { AaveV3Base } from '@bgd-labs/aave-address-book';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface AssetConfig {
  decimals: number;
  liquidationBonus: number;
  symbol: string;
}

export class AssetManager {
  private publicClient: PublicClient;
  private protocolDataProvider: Address;
  private oracleAddress: Address;

  // Memori Penyimpanan Terpusat (Central Cache)
  private activeAssets: string[] = []; // Daftar alamat aset aktif
  private assetConfigs: Map<string, AssetConfig> = new Map();
  private addressesToMonitor: string[] = []; // Aset yang memiliki oracle (price feed) valid

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
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)'
  ]);

  private oracleAbi = parseAbi([
    'function getSourceOfAsset(address asset) external view returns (address)'
  ]);

  private configuratorEventsAbi = parseAbi([
    'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
    'event ReservePaused(address indexed asset, bool isPaused)',
    'event CollateralConfigurationChanged(address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)'
  ]);

  constructor(publicClient: any, protocolDataProvider: string) {
    this.publicClient = publicClient;
    this.protocolDataProvider = protocolDataProvider as Address;
    this.oracleAddress = config.aave.oracle as Address;
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

    this.activeAssets = reserves.map(r => r.tokenAddress.toLowerCase());

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

    // Eksekusi secara paralel
    const [configResults, oracleResults] = await Promise.all([
      this.publicClient.multicall({ contracts: configContracts }),
      this.publicClient.multicall({ contracts: oracleContracts })
    ]);

    this.assetConfigs.clear();
    this.addressesToMonitor = [];

    // 3. Olah hasil balasan RPC dan simpan ke memori lokal
    for (let i = 0; i < reserves.length; i++) {
      const reserve = reserves[i];
      const address = reserve.tokenAddress.toLowerCase();
      const configRes = configResults[i];
      const oracleRes = oracleResults[i];

      // Memproses desimal dan bonus likuidasi
      if (configRes.status === 'success') {
        const data = configRes.result as readonly any[];
        const decimals = Number(data[0]);
        const liquidationBonusRaw = Number(data[3]);
        // Konversi format Aave V3: 10500 berarti bonus 5%
        const liquidationBonus = liquidationBonusRaw > 0 ? (liquidationBonusRaw - 10000) / 100 : 0;

        this.assetConfigs.set(address, {
          symbol: reserve.symbol,
          decimals,
          liquidationBonus
        });
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
   * @notice Mengaktifkan event listener pada kontrak Aave PoolConfigurator.
   * @dev Fungsi ini akan memantau perubahan status aset secara real-time dari blockchain.
   */
  public startEventListening(): void {
    logger.info('Starting Aave PoolConfigurator Event Listener...');

    // 1. ReserveInitialized (Saat koin baru didaftarkan ke Aave)
    this.publicClient.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'ReserveInitialized',
      onLogs: async (logs) => {
        for (const log of logs) {
          const assetAddress = log.args.asset;
          if (assetAddress) {
            logger.info(`[Event] New Reserve Initialized: ${assetAddress}. Re-syncing cache...`);
            // Lakukan sinkronisasi ulang secara penuh
            await this.initialize();
          }
        }
      }
    });

    // 2. ReservePaused (Saat fitur borrow/collateral koin dibekukan Aave)
    this.publicClient.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'ReservePaused',
      onLogs: async (logs) => {
        for (const log of logs) {
          const assetAddress = log.args.asset?.toLowerCase();
          const isPaused = log.args.isPaused;
          if (assetAddress && isPaused) {
            logger.info(`[Event] Reserve Paused: ${assetAddress}. Removing from monitor.`);
            this.addressesToMonitor = this.addressesToMonitor.filter(a => a !== assetAddress);
          } else if (assetAddress && !isPaused) {
            logger.info(`[Event] Reserve Unpaused: ${assetAddress}. Re-syncing cache...`);
            await this.initialize();
          }
        }
      }
    });

    // 3. CollateralConfigurationChanged (Saat Aave mengubah angka Liquidation Bonus / LTV)
    this.publicClient.watchContractEvent({
      address: AaveV3Base.POOL_CONFIGURATOR as Address,
      abi: this.configuratorEventsAbi,
      eventName: 'CollateralConfigurationChanged',
      onLogs: (logs) => {
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
      }
    });
  }
}
