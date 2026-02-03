import { createPublicClient, webSocket, parseAbiItem, formatUnits, http, Chain } from 'viem';
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
}

export class PriceOracle {
  private publicClient: any;
  private wsClient: any = null;
  private lastPrices: Map<string, number> = new Map();
  private isMonitoring = false;
  private aggregators: Map<string, ChainlinkAggregator> = new Map();
  private unsubscribeFns: (() => void)[] = [];
  private onFatalError: (() => void) | null = null;
  private readonly AAVE_ORACLE: `0x${string}`;
  private ORACLE_ABI = [
    {
      inputs: [{ name: 'asset', type: 'address' }],
      name: 'getAssetPrice',
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
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
      inputs: [],
      name: 'latestAnswer',
      outputs: [{ name: '', type: 'int256' }],
      stateMutability: 'view',
      type: 'function',
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
      name: 'description',
      outputs: [{ name: '', type: 'string' }],
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
    // Override basePreconf to use custom RPC URL
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
      priceMap.set(asset, price);
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
   * @notice Start monitoring price changes via Chainlink events
   * @dev Initializes WebSocket, sets up aggregators, subscribes to AnswerUpdated events
   * @param assets Array of asset addresses to monitor
   * @param onPriceChange Callback function invoked on price updates
   */
  async startPriceMonitoring(assets: string[], onPriceChange: (updates: PriceUpdate[]) => void, wssUrl: string): Promise<void> {
    if (this.isMonitoring) return;
    this.initializeWebSocketClient(wssUrl);
    this.isMonitoring = true;
    await this.setupChainlinkAggregators(assets);
    this.subscribeToChainlinkEvents(assets, onPriceChange);
    logger.info(`Monitoring ${this.aggregators.size} Chainlink aggregators`);
  }

  /**
   * @notice Get Chainlink aggregator addresses for assets
   * @dev Uses multicall for efficiency, queries proxy addresses and aggregator details
   * @param assets Array of asset addresses to setup
   */
  private async setupChainlinkAggregators(assets: string[]): Promise<void> {
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
    const proxyAddressCalls = assets.map(asset => ({
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
    for (let i = 0; i < assets.length; i++) {
      const result = proxyResults[i];
      if (result.status === 'success' && result.result) {
        const proxyAddress = result.result as `0x${string}`;
        if (proxyAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
          validAssets.push(assets[i]);
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
    for (let i = 0; i < validAssets.length; i++) {
      const asset = validAssets[i];
      const underlyingAddress = aggregatorResults[i].status === 'success' 
        ? aggregatorResults[i].result as `0x${string}` 
        : validProxies[i];
      const decimals = decimalsResults[i].status === 'success' 
        ? decimalsResults[i].result as number 
        : 8;
      this.aggregators.set(asset, { address: underlyingAddress, decimals });
    }
  }

  /**
   * @notice Subscribe to Chainlink AnswerUpdated events via WebSocket
   * @dev Uses single WebSocket subscription with address filter for all aggregators
   * @param assets Array of asset addresses being monitored
   * @param onPriceChange Callback function for price updates
   */
  private subscribeToChainlinkEvents(assets: string[], onPriceChange: (updates: PriceUpdate[]) => void): void {
    const aggregatorAddresses = Array.from(this.aggregators.values()).map(agg => agg.address);
    const unsubscribe = this.wsClient!.watchEvent({
      address: aggregatorAddresses as `0x${string}`[],
      event: parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)'),
      onLogs: async (logs: any[]) => {
        for (const log of logs) {
          try {
            const eventAddress = log.address.toLowerCase();
            let matchedAsset: string | undefined;
            let matchedAggregator: { address: string; decimals: number } | undefined;
            for (const [asset, aggregator] of this.aggregators.entries()) {
              if (aggregator.address.toLowerCase() === eventAddress) {
                matchedAsset = asset;
                matchedAggregator = aggregator;
                break;
              }
            }
            if (!matchedAsset || !matchedAggregator) continue;
            const { current } = log.args;
            const newPrice = parseFloat(formatUnits(current as bigint, matchedAggregator.decimals));
            const oldPrice = this.lastPrices.get(matchedAsset);
            this.lastPrices.set(matchedAsset, newPrice);
            const percentChange = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : 0;
            const update: PriceUpdate = {
              asset: matchedAsset,
              oldPrice: oldPrice || newPrice,
              newPrice,
              percentChange,
              source: 'chainlink',
            };
            onPriceChange([update]);
          } catch (error) {
            logger.error('Error handling AnswerUpdated event:', error);
          }
        }
      },
      onError: (error: any) => {
        const errorMsg = error?.message || error?.toString() || 'Unknown error';
        logger.error(`WebSocket error: ${errorMsg}`);
        this.stopPriceMonitoring();
        if (this.onFatalError) {
          this.onFatalError();
        }
      },
    });
    this.unsubscribeFns.push(unsubscribe);
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
  }
}
