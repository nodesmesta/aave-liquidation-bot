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
      transport: http(),
    });
    const rpcPublicClient = createPublicClient({
      chain: this.chain,
      transport: http(rpcUrl),
    });
    this.gasManager = new GasManager(rpcPublicClient);
    this.nonceManager = new NonceManager(rpcPublicClient, this.account.address);
    if (!config.liquidator.address) {
      throw new Error('Liquidator contract address not configured');
    }
  }

  /**
   * @notice Initialize nonce and gas managers at bot startup
   * @dev Initializes nonce manager and confirms flashblocks integration
   */
  async initialize(): Promise<void> {
    await this.nonceManager.initialize();
    logger.info(`Flashblocks integration: walletClient (broadcast) and publicClient (receipt) via mainnet-preconf.base.org`);
  }

  /**
   * @notice Record failed liquidation attempt
   * @dev Updates failure stats and consecutive loss counter
   */
  private recordFailure(): void {
    this.stats.failedLiquidations++;
    this.stats.consecutiveLosses++;
  }

  /**
   * @notice Poll transaction receipt from Flashblocks endpoint
   * @dev Standard eth_getTransactionReceipt call on Flashblocks-aware RPC
   * Flashblocks returns receipt when TX is preconfirmed (200ms) or on-chain
   * @param hash Transaction hash to poll
   * @param maxWaitTime Max wait time in ms (default 5s for Flashblocks preconf timing)
   * @return Transaction receipt or null if timeout
   */
  private async pollTransactionConfirmation(hash: `0x${string}`, maxWaitTime: number = 5_000): Promise<any> {
    const pollInterval = 100;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      if (receipt) {
        return receipt;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    return null;
  }

  /**
   * @notice Calculate gas settings for liquidation with affordability check
   * @dev Fetches network fees, calculates boosted gas settings, and validates against wallet balance
   * @param gasLimit Gas limit for the transaction
   * @param liquidationValueUSD Estimated liquidation value in USD
   * @param walletBalanceETH Wallet balance in ETH for affordability check
   * @return Gas settings with affordability flag, or null if unaffordable
   */
  async calculateAffordableGasSettings(
    gasLimit: bigint,
    liquidationValueUSD: number,
    walletBalanceETH: number
  ): Promise<{ gasSettings: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gas: bigint }; maxGasCostETH: number } | null> {
    const baseFees = await this.gasManager.getEstimatedFees();
    const gasSettings = this.gasManager.calculateGasSettings(baseFees, gasLimit, liquidationValueUSD);
    const maxGasCostETH = this.gasManager.calculateMaxGasCostETH(gasSettings);
    if (walletBalanceETH < maxGasCostETH) {
      return null;
    }
    return { gasSettings, maxGasCostETH };
  }

  /**
   * @notice Execute liquidation with flashblocks optimization
   * @dev Uses EIP-1559 gas with dynamic priority fee. Implements pre-signing, sequencer verification, and on-chain confirmation
   * @param collateralAsset Address of collateral asset to seize
   * @param debtAsset Address of debt asset to repay
   * @param user Address of user to liquidate
   * @param debtToCover Amount of debt to cover
   * @param estimatedValue Estimated liquidation value in USD for gas calculation
   * @param gasSettings Pre-calculated gas settings (maxFeePerGas, maxPriorityFeePerGas, gas)
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
    let hash: `0x${string}` | undefined;
    let prepareTime: number;
    let signTime: number;
    let broadcastTime: number;
    logger.info(`Executing liquidation: ${user.slice(0,6)}...${user.slice(-4)}, nonce ${nonce}, value $${estimatedValue.toFixed(0)}`);
    try {
      const prepareStart = Date.now();
      const data = encodeFunctionData({
        abi: this.liquidatorAbi,
        functionName: 'executeLiquidation',
        args: [collateralAsset as Address, debtAsset as Address, user as Address, debtToCover],
      });
      prepareTime = Date.now() - prepareStart;
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
      signTime = Date.now() - signStart;
      const broadcastStart = Date.now();
      hash = await this.walletClient.sendRawTransaction({
        serializedTransaction: signedTx,
      });
      broadcastTime = Date.now() - broadcastStart;
    } catch (preConfirmError: any) {
      release();
      const errorMsg = `Failed before sequencer confirmation: ${preConfirmError.message}`;
      logger.error(errorMsg);
      this.recordFailure();
      return { success: false, error: errorMsg };
    }
    try {
      const verifyStart = Date.now();
      const statusResponse: any = await this.walletClient.transport.request({
        method: 'base_transactionStatus',
        params: [hash],
      });
      const verifyTime = Date.now() - verifyStart;
      if (statusResponse?.status !== 'Known') {
        release();
        const errorMsg = `TX rejected by sequencer: ${hash} (status: ${statusResponse?.status || 'null'})`;
        logger.error(errorMsg);
        this.recordFailure();
        return { success: false, error: errorMsg };
      }
      this.nonceManager.confirmNonce(nonce);
      logger.info(`TX broadcast: ${hash} | Sequencer accepted (prepare: ${prepareTime}ms, sign: ${signTime}ms, broadcast: ${broadcastTime}ms, verify: ${verifyTime}ms)`);
    } catch (verifyError: any) {
      release();
      const errorMsg = `Failed to verify TX with sequencer: ${verifyError.message}`;
      logger.error(errorMsg);
      this.recordFailure();
      return { success: false, error: errorMsg };
    }
    try {
      const receipt = await this.pollTransactionConfirmation(hash);
      if (!receipt) {
        logger.error(`TX confirmation timeout: ${hash} - TX may still be pending on-chain`);
        this.recordFailure();
        return {
          success: false,
          error: 'Transaction confirmation timeout',
        };
      }
      logger.info(`Liquidation successful: ${receipt.transactionHash}, gas ${receipt.gasUsed}`);
      this.stats.successfulLiquidations++;
      this.stats.totalGasSpent = this.stats.totalGasSpent + receipt.gasUsed;
      this.stats.consecutiveLosses = 0;
      return {
        success: true,
        txHash: receipt.transactionHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (error: any) {
      logger.error(`Error during TX confirmation: ${error.message}`);
      this.recordFailure();
      return {
        success: false,
        error: error.message || 'Transaction confirmation failed',
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
    const receipt = await this.pollTransactionConfirmation(hash);
    if (!receipt) throw new Error(`Failed to confirm ownership transfer for TX: ${hash}`);
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
