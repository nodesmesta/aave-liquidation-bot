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
   * @notice Get optimal gas settings for transaction with dynamic priority fee
   * @dev Priority fee scales with liquidation value: 1 gwei base + 0.005 gwei per $1
   * @param gasLimit Gas limit for the transaction
   * @param liquidationValueUSD Liquidation value in USD for dynamic fee calculation
   * @return Gas settings with maxFeePerGas, maxPriorityFeePerGas, and gas
   */
  async getOptimalGasSettings(gasLimit: bigint, liquidationValueUSD: number): Promise<GasSettings> {
    const gasPrice = await this.publicClient.getGasPrice();
    const baseFee = gasPrice;
    const basePriorityFee = 1000000000n;
    const valueAbove100 = Math.max(0, liquidationValueUSD - 100);
    const additionalPriorityGwei = valueAbove100 * 0.005;
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
