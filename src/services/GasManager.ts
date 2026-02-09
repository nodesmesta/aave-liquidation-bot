export interface GasSettings {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

export class GasManager {
  private publicClient: any;

  constructor(publicClient: any) {
    this.publicClient = publicClient;
  }

  /**
   * @notice Get current gas price from RPC
   * @dev Fetches fresh gas price on-demand
   * @return Current gas price in wei
   */
  async getGasPrice(): Promise<bigint> {
    return await this.publicClient.getGasPrice();
  }

  /**
   * @notice Calculate optimal gas settings with dynamic priority fee
   * @dev Priority fee scales with liquidation value: 0.2 gwei per $100 USD
   *      Formula: (liquidationValueUSD / 100) * 0.2 gwei
   *      Example: $1000 liquidation = (1000/100) * 0.2 = 2 gwei priority fee
   * @param gasPrice Current gas price in wei
   * @param gasLimit Gas limit for the transaction
   * @param liquidationValueUSD Liquidation value in USD (debt + bonus = total profitability)
   * @return Gas settings with maxFeePerGas, maxPriorityFeePerGas, and gas
   */
  calculateGasSettings(
    gasPrice: bigint,
    gasLimit: bigint,
    liquidationValueUSD: number
  ): GasSettings {
    const priorityFeeGwei = (liquidationValueUSD / 100) * 0.2;
    const priorityFee = BigInt(Math.floor(priorityFeeGwei * 1e9));
    const maxFeePerGas = (gasPrice * 110n) / 100n + priorityFee;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      gas: gasLimit,
    };
  }
}
