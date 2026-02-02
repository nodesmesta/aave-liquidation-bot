import { createPublicClient, createWalletClient as viemCreateWalletClient, http, parseAbi, Address } from 'viem';
import { base } from 'viem/chains';
import { config } from '../config';
import { logger } from '../utils/logger';
import { createAccount } from '../utils/wallet';
import { GasManager } from './GasManager';
import { NonceManager } from './NonceManager';

/**
 * @notice Result of a liquidation execution attempt
 */
export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
}

/**
 * @notice Handles liquidation execution with thread-safe nonce management
 * @dev Manages wallet client, gas settings, and transaction broadcasting
 */
export class LiquidationExecutor {
  private account: ReturnType<typeof createAccount>;
  private walletClient: ReturnType<typeof viemCreateWalletClient>;
  private publicClient: any; // PublicClient type causes conflicts with multiple viem imports
  private gasManager: GasManager;
  private nonceManager: NonceManager;
  private liquidatorAbi = parseAbi([
    'function executeLiquidation(address collateralAsset, address debtAsset, address user, uint256 debtToCover) external',
    'function transferOwnership(address newOwner) external',
    'function approveToken(address token, address spender, uint256 amount) external',
    'function isAaveReserve(address token) public view returns (bool)',
  ]);
  private stats = {
    totalAttempts: 0,
    successfulLiquidations: 0,
    failedLiquidations: 0,
    totalGasSpent: 0n,
    consecutiveLosses: 0,
  };

  constructor(rpcUrl: string, account?: ReturnType<typeof createAccount>) {
    this.account = account || createAccount();
    this.walletClient = viemCreateWalletClient({
      account: this.account,
      chain: base,
      transport: http(rpcUrl),
    });
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });
    this.gasManager = new GasManager(this.publicClient);
    this.nonceManager = new NonceManager(this.publicClient, this.account.address);
    if (!config.liquidator.address) {
      throw new Error('Liquidator contract address not configured');
    }
  }

  /**
   * @notice Initialize nonce manager (call once at startup)
   */
  async initialize(): Promise<void> {
    await this.nonceManager.initialize();
    logger.info('[LiquidationExecutor] Initialized with nonce manager');
  }

  /**
   * @notice Execute liquidation with simplified parameters
   * @dev Uses EIP-1559 gas with dynamic priority fee based on liquidation value
   * @param collateralAsset Address of collateral asset to seize
   * @param debtAsset Address of debt asset to repay
   * @param user Address of user to liquidate
   * @param debtToCover Amount of debt to cover
   * @param estimatedValue Estimated liquidation value in USD for dynamic gas pricing
   * @return Execution result with success status, txHash, and gas used
   */
  async executeLiquidation(
    collateralAsset: string,
    debtAsset: string,
    user: string,
    debtToCover: bigint,
    estimatedValue: number
  ): Promise<ExecutionResult> {
    this.stats.totalAttempts++;
    const { nonce, release } = await this.nonceManager.getNextNonce();
    try {
      logger.info(`Executing liquidation for ${user} with nonce ${nonce}`, {
        collateral: collateralAsset,
        debt: debtAsset,
        debtToCover: debtToCover.toString(),
        nonce,
      });
      const fixedGasLimit = 920000n;
      const gasSettings = await this.gasManager.getOptimalGasSettings(fixedGasLimit, estimatedValue);
      const hash = await this.walletClient.writeContract({
        address: config.liquidator.address as Address,
        abi: this.liquidatorAbi,
        functionName: 'executeLiquidation',
        args: [collateralAsset as Address, debtAsset as Address, user as Address, debtToCover],
        account: this.account,
        nonce: nonce,
        maxFeePerGas: gasSettings.maxFeePerGas,
        maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas,
        gas: gasSettings.gas,
        chain: base,
      });
      this.nonceManager.confirmNonce(nonce);
      
      logger.info(`Transaction sent: ${hash} (nonce: ${nonce})`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        logger.info(`Liquidation successful! TX: ${receipt.transactionHash}`);
        this.stats.successfulLiquidations++;
        this.stats.totalGasSpent = this.stats.totalGasSpent + receipt.gasUsed;
        this.stats.consecutiveLosses = 0;
        return {
          success: true,
          txHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed,
        };
      } else {
        throw new Error('Transaction reverted');
      }
    } catch (error: any) {
      if (!error.message?.includes('transaction hash') && !error.message?.includes('already known')) {
        release();
        logger.warn(`Released nonce ${nonce} due to failed TX`);
      }
      logger.error('Liquidation execution failed:', error);
      this.stats.failedLiquidations++;
      this.stats.consecutiveLosses++;
      if (this.shouldPause()) {
        logger.error('Circuit breaker triggered! Pausing bot...');
        throw new Error('Circuit breaker triggered');
      }
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * @notice Circuit breaker check
   * @dev Checks if consecutive losses exceed configured threshold
   * @return True if bot should pause, false otherwise
   */
  private shouldPause(): boolean {
    if (this.stats.consecutiveLosses >= config.circuitBreaker.maxConsecutiveLosses) {
      logger.error(`Circuit breaker: ${this.stats.consecutiveLosses} consecutive losses`);
      return true;
    }
    return false;
  }

  /**
   * @notice Transfer liquidator contract ownership
   * @dev Calls transferOwnership on liquidator contract
   * @param newOwner Address of new owner
   */
  async transferOwnership(newOwner: string): Promise<void> {
    logger.info(`Transferring ownership to ${newOwner}...`);
    const hash = await this.walletClient.writeContract({
      address: config.liquidator.address as Address,
      abi: this.liquidatorAbi,
      functionName: 'transferOwnership',
      args: [newOwner as Address],
      account: this.account,
      chain: base,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    logger.info(`Ownership transferred! TX: ${receipt.transactionHash}`);
  }

  /**
   * @notice Get wallet address
   * @return Wallet address
   */
  getAddress(): string {
    return this.account.address;
  }

  /**
   * @notice Get execution statistics
   * @dev Returns stats object with calculated success rate
   * @return Statistics including attempts, successes, failures, and success rate
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalAttempts > 0
        ? (this.stats.successfulLiquidations / this.stats.totalAttempts) * 100
        : 0,
    };
  }
}
