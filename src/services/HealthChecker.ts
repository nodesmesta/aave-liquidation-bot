import { createPublicClient, http, parseAbi, Address } from 'viem';
import { base } from 'viem/chains';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface UserHealth {
  user: string;
  healthFactor: number;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  status: 'LIQUIDATABLE' | 'CRITICAL' | 'WARNING' | 'SAFE';
}

export class HealthChecker {
  private poolAddress: string;
  private publicClient: any;
  private poolAbi = parseAbi([
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  ]);

  constructor(rpcUrl?: string, poolAddress?: string) {
    const resolvedRpcUrl = rpcUrl || config.network.rpcUrl;
    this.poolAddress = poolAddress || config.aave.pool;
    // Use base chain for read-only operations (better multicall compatibility)
    // basePreconf only needed for TX execution, not for read calls
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(resolvedRpcUrl),
    });
  }

  /**
   * @notice Check health factor for a single user
   * @dev Queries Aave Pool getUserAccountData and calculates status
   * @param userAddress Address of user to check
   * @return User health data including health factor and status
   */
  async checkUser(userAddress: string): Promise<UserHealth> {
    const result = await this.publicClient.readContract({
      address: this.poolAddress as Address,
      abi: this.poolAbi,
      functionName: 'getUserAccountData',
      args: [userAddress as Address],
    });
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = result as [bigint, bigint, bigint, bigint, bigint, bigint];
    const hf = Number(healthFactor) / 1e18;
    return {
      user: userAddress,
      healthFactor: hf,
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      status: this.determineStatus(hf),
    };
  }

  /**
   * @notice Check multiple users using viem multicall for maximum performance
   * @dev Batches users in chunks of 100 for safety, 100x faster than sequential calls
   * @param userAddresses Array of user addresses to check
   * @return Map of user address to health data
   */
  async checkUsers(userAddresses: string[]): Promise<Map<string, UserHealth>> {
    if (userAddresses.length === 0) return new Map();
    const results = new Map<string, UserHealth>();
    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(userAddresses.length / BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, userAddresses.length);
      const batchAddresses = userAddresses.slice(start, end);
      const multicallResults = await this.publicClient.multicall({
        contracts: batchAddresses.map(address => ({
          address: this.poolAddress as Address,
          abi: this.poolAbi,
          functionName: 'getUserAccountData',
          args: [address as Address],
        })),
      });
      for (let i = 0; i < multicallResults.length; i++) {
        const result = multicallResults[i];
        const userAddress = batchAddresses[i];
        if (result.status === 'success' && result.result) {
          const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = result.result as [bigint, bigint, bigint, bigint, bigint, bigint];
          const hf = Number(healthFactor) / 1e18;
          const status = this.determineStatus(hf);
          results.set(userAddress.toLowerCase(), {
            user: userAddress,
            healthFactor: hf,
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            status,
          });
        } else {
          logger.warn(`Failed to check user ${userAddress}: ${result.status}`);
        }
      }
    }
    return results;
  }

  /**
   * @notice Determine user status based on health factor
   * @dev Aligned with bot strategy (HF < 1.1): <1.0=LIQUIDATABLE, <1.05=CRITICAL, <1.1=WARNING, >=1.1=SAFE
   * @param healthFactor User's health factor (normalized to decimal)
   * @return Status label for the user
   */
  private determineStatus(healthFactor: number): UserHealth['status'] {
    if (healthFactor < 1.0) return 'LIQUIDATABLE';
    if (healthFactor < 1.05) return 'CRITICAL';
    if (healthFactor < 1.1) return 'WARNING';
    return 'SAFE';
  }

  /**
   * @notice Filter users with health factor below 1.0 (liquidatable)
   * @dev Extracts only users with status 'LIQUIDATABLE'
   * @param healthMap Map of user addresses to health data
   * @return Array of liquidatable users
   */
  filterLiquidatable(healthMap: Map<string, UserHealth>): UserHealth[] {
    return Array.from(healthMap.values()).filter(
      (health) => health.status === 'LIQUIDATABLE'
    );
  }

  /**
   * @notice Filter users with any risk level (not SAFE)
   * @dev Excludes only users with status 'SAFE' (HF >= 1.1)
   * @param healthMap Map of user addresses to health data
   * @return Array of risky users (LIQUIDATABLE, CRITICAL, or WARNING with HF < 1.1)
   */
  filterRisky(healthMap: Map<string, UserHealth>): UserHealth[] {
    return Array.from(healthMap.values()).filter(
      (health) => health.status !== 'SAFE'
    );
  }
}
