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

  constructor(rpcUrl: string, account?: ReturnType<typeof createAccount>) {
    this.account = account || createAccount();
    this.chain = basePreconf;
    this.walletClient = viemCreateWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(),
    });
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(rpcUrl),
    });
    this.gasManager = new GasManager(this.publicClient);
    this.nonceManager = new NonceManager(this.publicClient, this.account.address);
    if (!config.liquidator.address) {
      throw new Error('Liquidator contract address not configured');
    }
  }

  /**
   * @notice Initialize nonce and gas managers at bot startup
   * @dev Verifies flashblocks endpoint configuration and logs RPC endpoints
   */
  async initialize(): Promise<void> {
    await this.nonceManager.initialize();
    const walletRpcUrl = this.walletClient.transport.url || 'unknown';
    const publicRpcUrl = this.publicClient.transport.url || 'unknown';
    logger.info(`walletClient (TX broadcast): ${walletRpcUrl}`);
    logger.info(`publicClient (read operations): ${publicRpcUrl}`);
    if (walletRpcUrl.includes('mainnet-preconf.base.org')) {
      logger.info('Flashblocks enabled for TX broadcast');
    } else {
      throw new Error(`CRITICAL: Must use flashblocks endpoint! Current: ${walletRpcUrl}. Set BASE_RPC_URL=https://mainnet-preconf.base.org`);
    }
  }

  /**
   * @notice Execute liquidation with simplified parameters
   * @dev Uses EIP-1559 gas with dynamic priority fee based on liquidation value
   * @param collateralAsset Address of collateral asset to seize
   * @param debtAsset Address of transaction with flashblocks optimization
   * @dev Implements pre-signing, sequencer verification, and conditional timeout
   * @param collateralAsset Address of collateral asset to seize
   * @param debtAsset Address of debt asset to repay
   * @param user Address of user to liquidate
   * @param debtToCover Amount of debt to cover
   * @param estimatedValue Estimated liquidation value in USD for gas calculation
   * @param gasSettings Optional pre-calculated gas settings to avoid recalculation
   * @return Execution result with success status, txHash, and gas used
   */
  async executeLiquidation(
    collateralAsset: string,
    debtAsset: string,
    user: string,
    debtToCover: bigint,
    estimatedValue: number,
    gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }
  ): Promise<ExecutionResult> {
    this.stats.totalAttempts++;
    const { nonce, release } = await this.nonceManager.getNextNonce();
    try {
      logger.info(`Executing liquidation: ${user.slice(0,6)}...${user.slice(-4)}, nonce ${nonce}, value $${estimatedValue.toFixed(0)}`);
      const prepareStart = Date.now();
      const data = encodeFunctionData({
        abi: this.liquidatorAbi,
        functionName: 'executeLiquidation',
        args: [collateralAsset as Address, debtAsset as Address, user as Address, debtToCover],
      });
      const prepareTime = Date.now() - prepareStart;
      const signStart = Date.now();
      const signedTx = await this.account.signTransaction({
        to: config.liquidator.address as Address,
        data,
        nonce,
        maxFeePerGas: gasSettings.maxFeePerGas,
        maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas,
        gas: gasSettings.gas,
        chainId: this.chain.id,
      });
      const signTime = Date.now() - signStart;
      const broadcastStart = Date.now();
      const hash = await this.walletClient.sendRawTransaction({
        serializedTransaction: signedTx,
      });
      const broadcastTime = Date.now() - broadcastStart;
      const broadcastEndpoint = this.walletClient.transport.url || 'default';
      const verifyStart = Date.now();
      try {
        const statusResponse: any = await this.walletClient.transport.request({
          method: 'base_transactionStatus',
          params: [hash],
        });
        const verifyTime = Date.now() - verifyStart;
        if (statusResponse?.status !== 'Known') {
          release();
          const errorMsg = `TX rejected by sequencer: ${hash} (status: ${statusResponse?.status || 'null'})`;
          logger.error(errorMsg);
          this.stats.failedLiquidations++;
          return { success: false, error: errorMsg };
        }
        this.nonceManager.confirmNonce(nonce);
        logger.info(`TX sent: ${hash} -> ${broadcastEndpoint} Accepted by sequencer (prepare: ${prepareTime}ms, sign: ${signTime}ms, broadcast: ${broadcastTime}ms, verify: ${verifyTime}ms)`);
      } catch (verifyError: any) {
        release();
        const errorMsg = `Failed to verify TX with sequencer: ${verifyError.message}`;
        logger.error(errorMsg);
        this.stats.failedLiquidations++;
        return { success: false, error: errorMsg };
      }
      const waitTimeout = 60_000;
      const receipt = await this.publicClient.waitForTransactionReceipt({ 
        hash,
        timeout: waitTimeout,
      });
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
      const isTimeout = error.message?.includes('timeout') || error.message?.includes('timed out');
      const isTxKnown = error.message?.includes('transaction hash') || error.message?.includes('already known');
      if (!isTxKnown) {
        release();
        if (isTimeout) {
          logger.error(`TX timeout after wait - likely rejected or dropped: ${error.message}`);
        } else {
          logger.warn(`Released nonce ${nonce} due to failed TX: ${error.message}`);
        }
      }this.stats.consecutiveLosses++;
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
