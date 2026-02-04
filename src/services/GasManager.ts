import { createPublicClient, webSocket, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { logger } from '../utils/logger';

export interface GasSettings {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

export class GasManager {
  private publicClient: any;
  private wsClient: any = null;
  private cachedGasPrice: bigint | null = null;
  private isSubscribed = false;
  private wssUrl: string;
  private unsubscribeFn: (() => void) | null = null;

  constructor(publicClient: any, wssUrl: string) {
    this.publicClient = publicClient;
    this.wssUrl = wssUrl;
  }

  /**
   * @notice Initialize WebSocket subscription for gas price updates
   * @dev Subscribes to new blocks and caches gas price in memory
   */
  async initialize(): Promise<void> {
    try {
      // Override basePreconf to use custom RPC URL
      const customChain: Chain = {
        ...basePreconf,
        rpcUrls: {
          ...basePreconf.rpcUrls,
          default: { http: [this.wssUrl.replace('wss://', 'https://').replace('ws://', 'http://')] },
        },
      } as Chain;
      this.wsClient = createPublicClient({
        chain: customChain,
        transport: webSocket(this.wssUrl, {
          keepAlive: true,
          reconnect: true,
        }),
      });

      const initialGasPrice = await this.publicClient.getGasPrice();
      this.cachedGasPrice = initialGasPrice;
      logger.info(`GasManager initialized with gas price: ${initialGasPrice.toString()} wei`);

      this.unsubscribeFn = await this.wsClient.watchBlocks({
        onBlock: async (block: any) => {
          try {
            const gasPrice = await this.wsClient.getGasPrice();
            this.cachedGasPrice = gasPrice;
          } catch (error) {
            logger.error('Failed to update gas price from WebSocket:', error);
          }
        },
        onError: (error: Error) => {
          logger.error('WebSocket gas price subscription error:', error);
        },
      });

      this.isSubscribed = true;
      logger.info('Gas price WebSocket subscription active');
    } catch (error) {
      logger.error('Failed to initialize gas price subscription:', error);
      const fallbackGasPrice = await this.publicClient.getGasPrice();
      this.cachedGasPrice = fallbackGasPrice;
      logger.warn('Using fallback RPC mode for gas price');
    }
  }

  /**
   * @notice Get current gas price from cache or fallback to RPC
   * @dev Uses cached value if available, otherwise queries RPC
   * @return Current gas price in wei
   */
  private async getGasPrice(): Promise<bigint> {
    if (this.cachedGasPrice !== null) {
      return this.cachedGasPrice;
    }
    logger.warn('Gas price cache miss, fetching from RPC');
    const gasPrice = await this.publicClient.getGasPrice();
    this.cachedGasPrice = gasPrice;
    return gasPrice;
  }

  /**
   * @notice Cleanup WebSocket subscription
   */
  destroy(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.isSubscribed = false;
    logger.info('Gas price WebSocket subscription closed');
  }

  /**
   * @notice Get optimal gas settings for transaction with dynamic priority fee
   * @dev Priority fee scales with liquidation value (includes debt + bonus)
   *      Formula: 1 gwei + (value-100)*0.01 gwei (1 gwei per $100)
   * @param gasLimit Gas limit for the transaction
   * @param liquidationValueUSD Liquidation value in USD (debt + bonus = total profitability)
   * @return Gas settings with maxFeePerGas, maxPriorityFeePerGas, and gas
   */
  async getOptimalGasSettings(
    gasLimit: bigint,
    liquidationValueUSD: number
  ): Promise<GasSettings> {
    const gasPrice = await this.getGasPrice();
    const baseFee = gasPrice;
    const basePriorityFee = 1_000_000_000n;
    const valueAbove100 = Math.max(0, liquidationValueUSD - 100);
    const additionalPriorityGwei = valueAbove100 * 0.01;
    const additionalPriorityWei = BigInt(Math.floor(additionalPriorityGwei * 1e9));
    const priorityFee = basePriorityFee + additionalPriorityWei;
    const maxFeePerGas = (baseFee * 110n) / 100n + priorityFee;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      gas: gasLimit,
    };
  }
}
