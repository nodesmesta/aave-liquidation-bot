import { parseAbi, Address } from 'viem';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  HF_RAW,
  hfRawToNumber,
  isLiquidatableRaw,
  formatHF,
} from '../config/thresholds';

export interface UserHealth {
  user: string;
  /** Raw 1e18-scaled health factor. `type(uint256).max` when the user has no debt. */
  healthFactorRaw: bigint;
  /** Display-only decimal health factor (truncated, never rounded). Infinity when no debt. */
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

  constructor(publicClient: any, poolAddress?: string) {
    this.poolAddress = poolAddress || config.aave.pool;
    this.publicClient = publicClient;
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
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactorRaw] = result as [bigint, bigint, bigint, bigint, bigint, bigint];
    return {
      user: userAddress,
      healthFactorRaw,
      healthFactor: hfRawToNumber(healthFactorRaw),
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      status: this.determineStatus(healthFactorRaw),
    };
  }

  /**
   * @notice Check multiple users using viem multicall for maximum performance
   * @dev Batches users using the shared rate-limit config and `allowFailure: true` so a single
   *      reverting user cannot invalidate the whole batch.
   * @param userAddresses Array of user addresses to check
   * @return Map of user address to health data
   */
  async checkUsers(userAddresses: string[]): Promise<Map<string, UserHealth>> {
    if (userAddresses.length === 0) return new Map();
    const results = new Map<string, UserHealth>();
    const BATCH_SIZE = config.rateLimit.batchSize;
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
        allowFailure: true,
      });
      for (let i = 0; i < multicallResults.length; i++) {
        const result = multicallResults[i];
        const userAddress = batchAddresses[i];
        if (result.status === 'success' && result.result) {
          const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactorRaw] = result.result as [bigint, bigint, bigint, bigint, bigint, bigint];
          results.set(userAddress.toLowerCase(), {
            user: userAddress,
            healthFactorRaw,
            healthFactor: hfRawToNumber(healthFactorRaw),
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            status: this.determineStatus(healthFactorRaw),
          });
        } else {
          const errorMsg = result.error?.message || result.status;
          logger.warn(`Failed to check user ${userAddress}: ${errorMsg}`);
        }
      }
    }
    return results;
  }

  /**
   * @notice Determine user status from the raw health factor
   * @dev All comparisons are bigint, so a HF of 0.999999999999999999 is correctly LIQUIDATABLE.
   * @param healthFactorRaw Raw 1e18-scaled health factor
   * @return Status label for the user
   */
  private determineStatus(healthFactorRaw: bigint): UserHealth['status'] {
    if (healthFactorRaw < HF_RAW.ONE) return 'LIQUIDATABLE';
    if (healthFactorRaw < HF_RAW.CRITICAL) return 'CRITICAL';
    if (healthFactorRaw < HF_RAW.WARNING) return 'WARNING';
    return 'SAFE';
  }

  /**
   * @notice Filter users with health factor below 1.0 (liquidatable)
   * @dev Uses the raw bigint comparison, not the display number.
   * @param healthMap Map of user addresses to health data
   * @return Array of liquidatable users
   */
  filterLiquidatable(healthMap: Map<string, UserHealth>): UserHealth[] {
    return Array.from(healthMap.values()).filter(
      (health) => isLiquidatableRaw(health.healthFactorRaw)
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

  /** @notice Format a user's HF for logging. */
  formatHF(health: UserHealth): string {
    return formatHF(health.healthFactorRaw);
  }
}
