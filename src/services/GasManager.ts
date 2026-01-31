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
   * @notice Get optimal gas settings for transaction
   * @dev Optimized for Base L2 FIFO sequencer - no buffering needed (handled at caller level)
   * @param gasLimit Gas limit for the transaction (no additional buffer applied)
   * @return Gas settings with maxFeePerGas, maxPriorityFeePerGas, and gas
   */
  async getOptimalGasSettings(gasLimit: bigint): Promise<GasSettings> {
    const gasPrice = await this.publicClient.getGasPrice();
    const baseFee = gasPrice;
    const priorityFee = 1000000000n;
    const maxFeePerGas = (baseFee * 110n) / 100n + priorityFee;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      gas: gasLimit,
    };
  }
}
