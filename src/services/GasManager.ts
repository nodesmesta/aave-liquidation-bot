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

      this.unsubscribeFn = await this.wsClient.watchBlocks({
        onBlock: (block: any) => {
          if (block.baseFeePerGas) {
            this.cachedGasPrice = block.baseFeePerGas;
          }
        },
        onError: (error: Error) => {
          this.cachedGasPrice = null;
        },
      });

      this.isSubscribed = true;
    } catch (error) {
      const fallbackGasPrice = await this.publicClient.getGasPrice();
      this.cachedGasPrice = fallbackGasPrice;
    }
  }

  /**
   * @notice Get current gas price from cache or fallback to RPC
   * @dev Uses cached value if available, otherwise queries RPC
   * @return Current gas price in wei
   */
  async getGasPrice(): Promise<bigint> {
    if (this.cachedGasPrice !== null) {
      return this.cachedGasPrice;
    }
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
  }

  /**
   * @notice Get optimal gas settings for transaction with dynamic priority fee
   * @dev Priority fee scales with liquidation value: 0.2 gwei per $100 USD
   *      Formula: (liquidationValueUSD / 100) * 0.2 gwei
   *      Example: $1000 liquidation = (1000/100) * 0.2 = 2 gwei priority fee
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
    const priorityFeeGwei = (liquidationValueUSD / 100) * 0.2;
    const priorityFee = BigInt(Math.floor(priorityFeeGwei * 1e9));
    const maxFeePerGas = (baseFee * 110n) / 100n + priorityFee;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      gas: gasLimit,
    };
  }
}
