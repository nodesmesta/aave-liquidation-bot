import { createPublicClient, webSocket, parseAbiItem, formatUnits, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface PriceUpdate {
  asset: string;
  oldPrice: number;
  newPrice: number;
  percentChange: number;
  source: 'chainlink';
}

interface ChainlinkAggregator {
  address: `0x${string}`;
  decimals: number;
  isDualAggregator: boolean;
}

export class PriceOracle {
  private publicClient: any;
  private wsClient: any = null;
  private lastPrices: Map<string, number> = new Map();
  private isMonitoring = false;
  private aggregators: Map<string, ChainlinkAggregator> = new Map();
  private aggregatorToAssets: Map<string, Array<{ asset: string; decimals: number; isDualAggregator: boolean }>> = new Map();
  private roundPrices: Map<string, number> = new Map();
  private unsubscribeFns: (() => void)[] = [];
  private onFatalError: (() => void) | null = null;
  private onPriceChangeCallback: ((updates: PriceUpdate[]) => void) | null = null;
  private readonly AAVE_ORACLE: `0x${string}`;

  private ORACLE_ABI = [
    {
      inputs: [{ name: 'assets', type: 'address[]' }],
      name: 'getAssetsPrices',
      outputs: [{ name: '', type: 'uint256[]' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ name: 'asset', type: 'address' }],
      name: 'getSourceOfAsset',
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const;

  private CHAINLINK_ABI = [
    {
      anonymous: false,
      inputs: [
        { indexed: true, name: 'current', type: 'int256' },
        { indexed: true, name: 'roundId', type: 'uint256' },
        { indexed: false, name: 'updatedAt', type: 'uint256' },
      ],
      name: 'AnswerUpdated',
      type: 'event',
    },
    {
      anonymous: false,
      inputs: [
        { indexed: true, name: 'secondaryRoundId', type: 'uint32' },
      ],
      name: 'SecondaryRoundIdUpdated',
      type: 'event',
    },
    {
      inputs: [],
      name: 'decimals',
      outputs: [{ name: '', type: 'uint8' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'aggregator',
      outputs: [{ name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ name: '_roundId', type: 'uint80' }],
      name: 'getRoundData',
      outputs: [
        { name: 'roundId', type: 'uint80' },
        { name: 'answer', type: 'int256' },
        { name: 'startedAt', type: 'uint256' },
        { name: 'updatedAt', type: 'uint256' },
        { name: 'answeredInRound', type: 'uint80' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'typeAndVersion',
      outputs: [{ name: '', type: 'string' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const;

  constructor(publicClient: any) {
    this.AAVE_ORACLE = config.aave.oracle as `0x${string}`;
    this.publicClient = publicClient;
  }

  /**
   * @notice Initialize WebSocket connection for event subscriptions
   * @dev Creates WebSocket client only when needed (lazy initialization)
   */
  private initializeWebSocketClient(wssUrl: string): void {
    if (this.wsClient) return;
    const customChain: Chain = {
      ...basePreconf,
      rpcUrls: {
        ...basePreconf.rpcUrls,
        default: { http: [wssUrl.replace('wss://', 'https://').replace('ws://', 'http://')] },
      },
    } as Chain;
    this.wsClient = createPublicClient({
      chain: customChain,
      transport: webSocket(wssUrl, {
        keepAlive: true,
        reconnect: true,
      }),
    });
    logger.info('WebSocket connected');
  }

  /**
   * @notice Get prices of multiple assets from Aave Oracle
   * @dev Queries getAssetsPrices in single multicall for efficiency
   * @param assetAddresses Array of asset addresses to query
   * @return Map of asset address to price in USD (8 decimals)
   */
  async getAssetsPrices(assetAddresses: string[]): Promise<Map<string, number>> {
    const prices = await this.publicClient.readContract({
      address: this.AAVE_ORACLE,
      abi: this.ORACLE_ABI,
      functionName: 'getAssetsPrices',
      args: [assetAddresses as `0x${string}`[]],
    }) as bigint[];
    const priceMap = new Map<string, number>();
    assetAddresses.forEach((asset, index) => {
      const price = parseFloat(formatUnits(prices[index], 8));
      priceMap.set(asset.toLowerCase(), price);
    });
    return priceMap;
  }

  /**
   * @notice Set callback for fatal WebSocket errors
   * @dev Called when WebSocket connection fails permanently
   * @param callback Function to invoke on fatal error
   */
  setFatalErrorHandler(callback: () => void): void {
    this.onFatalError = callback;
  }

  /**
   * @notice Seed initial prices from Aave Oracle for baseline tracking
   * @param assets Array of asset addresses
   */
  private async seedInitialPrices(assets: string[]): Promise<void> {
    try {
      const priceMap = await this.getAssetsPrices(assets);
      for (const [asset, price] of priceMap.entries()) {
        this.lastPrices.set(asset.toLowerCase(), price);
      }
      logger.info(`Seeded initial prices for ${priceMap.size} assets`);
    } catch (error) {
      logger.warn('Failed to seed initial prices from Aave Oracle:', error);
    }
  }

  /**
   * @notice Start monitoring price changes via Chainlink events
   * @dev Initializes WebSocket, sets up aggregators, subscribes to AnswerUpdated and SecondaryRoundIdUpdated events
   * @param assets Array of asset addresses to monitor
   * @param onPriceChange Callback function invoked on price updates
   */
  async startPriceMonitoring(assets: string[], onPriceChange: (updates: PriceUpdate[]) => void, wssUrl: string): Promise<void> {
    if (this.isMonitoring) return;
    this.onPriceChangeCallback = onPriceChange;
    this.initializeWebSocketClient(wssUrl);
    await this.setupChainlinkAggregators(assets);
    await this.seedInitialPrices(assets);
    this.subscribeToChainlinkEvents(onPriceChange);
    this.isMonitoring = true;
    logger.info(`Monitoring ${this.aggregators.size} Chainlink aggregators`);
  }

  /**
   * @notice Get Chainlink aggregator addresses for assets and classify DualAggregators (SVR)
   * @dev Uses multicall for efficiency, queries proxy addresses, aggregator details, and typeAndVersion
   * @param assets Array of asset addresses to setup
   */
  private async setupChainlinkAggregators(assets: string[]): Promise<void> {
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    const normalizedAssets = assets.map(a => a.toLowerCase());
    const proxyAddressCalls = normalizedAssets.map(asset => ({
      address: this.AAVE_ORACLE,
      abi: this.ORACLE_ABI,
      functionName: 'getSourceOfAsset',
      args: [asset as `0x${string}`],
    }));
    const proxyResults = await this.publicClient.multicall({
      contracts: proxyAddressCalls,
      allowFailure: true,
    });
    const validAssets: string[] = [];
    const validProxies: `0x${string}`[] = [];
    for (let i = 0; i < normalizedAssets.length; i++) {
      const result = proxyResults[i];
      if (result.status === 'success' && result.result) {
        const proxyAddress = result.result as `0x${string}`;
        if (proxyAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
          validAssets.push(normalizedAssets[i]);
          validProxies.push(proxyAddress);
        }
      }
    }
    const aggregatorCalls = validProxies.map(proxy => ({
      address: proxy,
      abi: this.CHAINLINK_ABI,
      functionName: 'aggregator',
    }));
    const decimalsCalls = validProxies.map(proxy => ({
      address: proxy,
      abi: this.CHAINLINK_ABI,
      functionName: 'decimals',
    }));
    const detailsResults = await this.publicClient.multicall({
      contracts: [...aggregatorCalls, ...decimalsCalls],
      allowFailure: true,
    });
    const aggregatorResults = detailsResults.slice(0, validProxies.length);
    const decimalsResults = detailsResults.slice(validProxies.length);

    const underlyingAddresses: `0x${string}`[] = [];
    for (let i = 0; i < validAssets.length; i++) {
      const underlyingAddress = aggregatorResults[i].status === 'success'
        ? aggregatorResults[i].result as `0x${string}`
        : validProxies[i];
      underlyingAddresses.push(underlyingAddress);
    }

    // Query typeAndVersion to identify DualAggregator (SVR enabled)
    const typeCalls = underlyingAddresses.map(addr => ({
      address: addr,
      abi: this.CHAINLINK_ABI,
      functionName: 'typeAndVersion',
    }));
    const typeResults = await this.publicClient.multicall({
      contracts: typeCalls,
      allowFailure: true,
    });

    for (let i = 0; i < validAssets.length; i++) {
      const asset = validAssets[i];
      const underlyingAddress = underlyingAddresses[i];
      const decimals = decimalsResults[i].status === 'success'
        ? decimalsResults[i].result as number
        : 8;
      const typeStr = typeResults[i].status === 'success' ? (typeResults[i].result as string) : '';
      const isDualAggregator = typeStr.includes('DualAggregator');

      const aggInfo: ChainlinkAggregator = {
        address: underlyingAddress,
        decimals,
        isDualAggregator,
      };

      this.aggregators.set(asset, aggInfo);

      const normalizedAgg = underlyingAddress.toLowerCase();
      if (!this.aggregatorToAssets.has(normalizedAgg)) {
        this.aggregatorToAssets.set(normalizedAgg, []);
      }
      const existing = this.aggregatorToAssets.get(normalizedAgg)!;
      if (!existing.some(e => e.asset === asset)) {
        existing.push({ asset, decimals, isDualAggregator });
      }
    }
  }

  /**
   * @notice Subscribe to Chainlink AnswerUpdated and SecondaryRoundIdUpdated events via WebSocket
   * @param onPriceChange Callback function for price updates
   */
  private subscribeToChainlinkEvents(onPriceChange: (updates: PriceUpdate[]) => void): void {
    const allAggregatorAddresses = Array.from(
      new Set(Array.from(this.aggregators.values()).map(agg => agg.address))
    );
    if (allAggregatorAddresses.length === 0) return;

    // 1. Subscribe to AnswerUpdated for all aggregators
    const unsubAnswerUpdated = this.wsClient!.watchEvent({
      address: allAggregatorAddresses,
      event: parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)'),
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          try {
            const eventAddress = log.address.toLowerCase();
            const assetEntries = this.aggregatorToAssets.get(eventAddress);
            if (!assetEntries || assetEntries.length === 0) continue;

            const { current, roundId } = log.args;
            const decimals = assetEntries[0].decimals;
            const newPrice = parseFloat(formatUnits(current as bigint, decimals));
            const roundIdStr = (roundId as bigint).toString();

            // Store in in-memory cache for fast 0ms resolution
            this.roundPrices.set(`${eventAddress}:${roundIdStr}`, newPrice);

            // Prune cache if it grows too large
            if (this.roundPrices.size > 500) {
              const firstKey = this.roundPrices.keys().next().value;
              if (firstKey) this.roundPrices.delete(firstKey);
            }

            const updates: PriceUpdate[] = [];
            for (const entry of assetEntries) {
              const oldPrice = this.lastPrices.get(entry.asset);
              if (oldPrice !== undefined && oldPrice === newPrice) {
                continue; // Deduplicate: already processed at this exact price
              }
              this.lastPrices.set(entry.asset, newPrice);
              const percentChange = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
              updates.push({
                asset: entry.asset,
                oldPrice: oldPrice || newPrice,
                newPrice,
                percentChange,
                source: 'chainlink',
              });
            }
            if (updates.length > 0) {
              onPriceChange(updates);
            }
          } catch (error) {
            logger.error('Error handling AnswerUpdated event:', error);
          }
        }
      },
      onError: (error: any) => {
        const errorMsg = error?.message || error?.toString() || 'Unknown error';
        logger.error(`WebSocket AnswerUpdated error: ${errorMsg}`);
        this.stopPriceMonitoring();
        if (this.onFatalError) {
          this.onFatalError();
        }
      },
    });
    this.unsubscribeFns.push(unsubAnswerUpdated);

    // 2. Subscribe to SecondaryRoundIdUpdated for SVR DualAggregator feeds
    const dualAggregatorAddresses = Array.from(
      new Set(
        Array.from(this.aggregators.values())
          .filter(agg => agg.isDualAggregator)
          .map(agg => agg.address)
      )
    );

    if (dualAggregatorAddresses.length > 0) {
      const unsubSecondary = this.wsClient!.watchEvent({
        address: dualAggregatorAddresses,
        event: parseAbiItem('event SecondaryRoundIdUpdated(uint32 indexed secondaryRoundId)'),
        onLogs: async (logs: any[]) => {
          for (const log of logs) {
            try {
              const eventAddress = log.address.toLowerCase();
              const assetEntries = this.aggregatorToAssets.get(eventAddress);
              if (!assetEntries || assetEntries.length === 0) continue;

              const { secondaryRoundId } = log.args;
              const roundIdStr = secondaryRoundId.toString();
              let newPrice = this.roundPrices.get(`${eventAddress}:${roundIdStr}`);

              // Fallback to RPC if cache missed (e.g. cold start / reconnect)
              if (newPrice === undefined) {
                try {
                  const roundData = await this.publicClient.readContract({
                    address: log.address,
                    abi: this.CHAINLINK_ABI,
                    functionName: 'getRoundData',
                    args: [BigInt(secondaryRoundId)],
                  }) as any;
                  newPrice = parseFloat(formatUnits(roundData[1] as bigint, assetEntries[0].decimals));
                  this.roundPrices.set(`${eventAddress}:${roundIdStr}`, newPrice);
                } catch (err) {
                  logger.warn(`[PriceOracle] Fallback getRoundData failed for round ${roundIdStr} on ${eventAddress}:`, err);
                  continue;
                }
              }

              const updates: PriceUpdate[] = [];
              for (const entry of assetEntries) {
                const oldPrice = this.lastPrices.get(entry.asset);
                if (oldPrice !== undefined && oldPrice === newPrice) {
                  continue; // Deduplicate: already processed at this exact price
                }
                this.lastPrices.set(entry.asset, newPrice);
                const percentChange = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
                updates.push({
                  asset: entry.asset,
                  oldPrice: oldPrice || newPrice,
                  newPrice,
                  percentChange,
                  source: 'chainlink',
                });
              }
              if (updates.length > 0) {
                logger.info(`[PriceOracle] SVR SecondaryRoundIdUpdated for ${assetEntries.map(e => e.asset).join(',')} round ${roundIdStr}: $${newPrice}`);
                onPriceChange(updates);
              }
            } catch (error) {
              logger.error('Error handling SecondaryRoundIdUpdated event:', error);
            }
          }
        },
        onError: (error: any) => {
          const errorMsg = error?.message || error?.toString() || 'Unknown error';
          logger.error(`WebSocket SecondaryRoundIdUpdated error: ${errorMsg}`);
          this.stopPriceMonitoring();
          if (this.onFatalError) {
            this.onFatalError();
          }
        },
      });
      this.unsubscribeFns.push(unsubSecondary);
    }
  }

  /**
   * @notice Add a new asset to monitoring without restarting the WebSocket connection
   * @param assetAddress Underlying asset contract address (Aave reserve token)
   */
  public async addAsset(assetAddress: string): Promise<void> {
    const normalized = assetAddress.toLowerCase();
    if (this.aggregators.has(normalized)) {
      logger.debug(`[PriceOracle] ${normalized} already monitored, skipping addAsset`);
      return;
    }
    await this.setupChainlinkAggregators([normalized]);
    if (!this.aggregators.has(normalized)) {
      logger.warn(`[PriceOracle] addAsset: no valid Chainlink Proxy found for ${normalized}, skipping`);
      return;
    }
    await this.seedInitialPrices([normalized]);
    if (this.isMonitoring && this.onPriceChangeCallback) {
      this.unsubscribeFns.forEach(unsub => unsub());
      this.unsubscribeFns = [];
      this.subscribeToChainlinkEvents(this.onPriceChangeCallback);
    }
    logger.info(`[PriceOracle] Asset added: ${normalized}. Monitoring ${this.aggregators.size} assets.`);
  }

  /**
   * @notice Remove an asset from monitoring without restarting the WebSocket connection
   * @param assetAddress Underlying asset contract address (Aave reserve token)
   */
  public removeAsset(assetAddress: string): void {
    const normalized = assetAddress.toLowerCase();
    if (!this.aggregators.has(normalized)) {
      return;
    }
    const agg = this.aggregators.get(normalized);
    this.aggregators.delete(normalized);
    this.lastPrices.delete(normalized);
    if (agg) {
      const aggAddress = agg.address.toLowerCase();
      const assets = this.aggregatorToAssets.get(aggAddress);
      if (assets) {
        const filtered = assets.filter(a => a.asset !== normalized);
        if (filtered.length > 0) {
          this.aggregatorToAssets.set(aggAddress, filtered);
        } else {
          this.aggregatorToAssets.delete(aggAddress);
        }
      }
    }
    if (this.isMonitoring && this.onPriceChangeCallback) {
      this.unsubscribeFns.forEach(unsub => unsub());
      this.unsubscribeFns = [];
      if (this.aggregators.size > 0) {
        this.subscribeToChainlinkEvents(this.onPriceChangeCallback);
      }
    }
    logger.info(`[PriceOracle] Asset removed: ${normalized}. Monitoring ${this.aggregators.size} assets.`);
  }

  /**
   * @notice Stop price monitoring and cleanup subscriptions
   * @dev Unsubscribes from WebSocket events and clears aggregator data
   */
  stopPriceMonitoring(): void {
    if (!this.isMonitoring) return;
    this.unsubscribeFns.forEach(unsubscribe => unsubscribe());
    this.unsubscribeFns = [];
    this.isMonitoring = false;
    this.aggregators.clear();
    this.aggregatorToAssets.clear();
    this.roundPrices.clear();
  }
}
