import { createPublicClient, createWalletClient as viemCreateWalletClient, http, parseAbi, Address, Chain, encodeFunctionData } from 'viem';
import { basePreconf } from 'viem/chains';
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
  private publicClient: any;
  private gasManager: GasManager;
  private nonceManager: NonceManager;
  private wssUrl: string;
  private chain: Chain;
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

  constructor(rpcUrl: string, account?: ReturnType<typeof createAccount>, wssUrl?: string) {
    this.account = account || createAccount();
    this.wssUrl = wssUrl || rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    
    // Use basePreconf for flashblocks support
    this.chain = basePreconf;
    
    // walletClient: Use basePreconf default transport for flashblocks TX inclusion
    // This will use https://mainnet-preconf.base.org for fast TX broadcast
    this.walletClient = viemCreateWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(), // No parameter - use basePreconf default RPC
    });
    
    // publicClient: Use Alchemy RPC for reliable read operations
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(rpcUrl), // Alchemy for reads
    });
    this.gasManager = new GasManager(this.publicClient, this.wssUrl);
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
    await this.gasManager.initialize();
  }

  /**
   * @notice Execute liquidation with simplified parameters
   * @dev Uses EIP-1559 gas with dynamic priority fee based on liquidation value
   * @param collateralAsset Address of collateral asset to seize
   * @param debtAsset Address of debt asset to repay
   * @param user Address of user to liquidate
   * @param debtToCover Amount of debt to cover
   * @param estimatedValue Estimated liquidation value in USD (debt + bonus)
   * @param gasSettings Optional pre-calculated gas settings (avoids recalculation)
   * @return Execution result with success status, txHash, and gas used
   */
  async executeLiquidation(
    collateralAsset: string,
    debtAsset: string,
    user: string,
    debtToCover: bigint,
    estimatedValue: number,
    gasSettings?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }
  ): Promise<ExecutionResult> {
    this.stats.totalAttempts++;
    const { nonce, release } = await this.nonceManager.getNextNonce();
    try {
      logger.info(`Executing liquidation: ${user.slice(0,6)}...${user.slice(-4)}, nonce ${nonce}, value $${estimatedValue.toFixed(0)}`);
      const fixedGasLimit = 920000n;
      // Use provided gas settings if available (avoids recalculation), otherwise calculate
      const finalGasSettings = gasSettings || await this.gasManager.getOptimalGasSettings(
        fixedGasLimit,
        estimatedValue
      );
      
      // Step 1: Prepare transaction (encode function call)
      const prepareStart = Date.now();
      const data = encodeFunctionData({
        abi: this.liquidatorAbi,
        functionName: 'executeLiquidation',
        args: [collateralAsset as Address, debtAsset as Address, user as Address, debtToCover],
      });
      const prepareTime = Date.now() - prepareStart;
      
      // Step 2: Sign transaction (CPU-intensive)
      const signStart = Date.now();
      const signedTx = await this.account.signTransaction({
        to: config.liquidator.address as Address,
        data,
        nonce,
        maxFeePerGas: finalGasSettings.maxFeePerGas,
        maxPriorityFeePerGas: finalGasSettings.maxPriorityFeePerGas,
        gas: finalGasSettings.gas,
        chainId: this.chain.id,
      });
      const signTime = Date.now() - signStart;
      
      // Step 3: Broadcast signed transaction (network I/O)
      const broadcastStart = Date.now();
      const hash = await this.walletClient.sendRawTransaction({
        serializedTransaction: signedTx,
      });
      const broadcastTime = Date.now() - broadcastStart;
      
      this.nonceManager.confirmNonce(nonce);
      logger.info(`TX sent: ${hash} (prepare: ${prepareTime}ms, sign: ${signTime}ms, broadcast: ${broadcastTime}ms)`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        logger.info(`Liquidation successful: ${receipt.transactionHash}, gas ${receipt.gasUsed}`);
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
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
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
      chain: this.chain,
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
