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
   * @notice Get current EIP-1559 fee estimates from RPC
   * @dev Fetches maxFeePerGas and maxPriorityFeePerGas from network
   * @return Fee estimates with maxFeePerGas and maxPriorityFeePerGas
   */
  async getEstimatedFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const fees = await this.publicClient.estimateFeesPerGas();
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }

  /**
   * @notice Calculate optimal gas settings with dynamic priority fee boost
   * @dev Priority fee boost scales with liquidation value: 0.2 gwei per $100 USD
   *      Formula: basePriorityFee + (liquidationValueUSD / 100) * 0.2 gwei
   *      Example: $1000 liquidation adds 2 gwei to base priority fee
   *      maxFeePerGas also boosted by 10% + priority boost for faster inclusion
   * @param baseFees Base fees from estimateFeesPerGas (network estimates)
   * @param gasLimit Gas limit for the transaction
   * @param liquidationValueUSD Liquidation value in USD (debt + bonus = total profitability)
   * @return Gas settings with boosted maxFeePerGas, maxPriorityFeePerGas, and gas
   */
  calculateGasSettings(
    baseFees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    gasLimit: bigint,
    liquidationValueUSD: number
  ): GasSettings {
    const priorityFeeBoostGwei = (liquidationValueUSD / 100) * 0.2;
    const priorityFeeBoost = BigInt(Math.floor(priorityFeeBoostGwei * 1e9));
    const maxPriorityFeePerGas = baseFees.maxPriorityFeePerGas + priorityFeeBoost;
    const maxFeePerGas = (baseFees.maxFeePerGas * 110n) / 100n + priorityFeeBoost;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      gas: gasLimit,
    };
  }

  /**
   * @notice Calculate maximum gas cost in ETH for gas settings
   * @dev Multiplies gas limit by maxFeePerGas to get worst-case cost
   * @param gasSettings Gas settings with maxFeePerGas and gas limit
   * @return Maximum gas cost in ETH as number
   */
  calculateMaxGasCostETH(gasSettings: GasSettings): number {
    const maxGasCostWei = gasSettings.gas * gasSettings.maxFeePerGas;
    return Number(maxGasCostWei) / 1e18;
  }
}
