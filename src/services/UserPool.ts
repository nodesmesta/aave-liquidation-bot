import { logger } from '../utils/logger';

/**
 * Represents a user being tracked for liquidation opportunities
 */
export interface TrackedUser {
  address: string;
  collateralAssets: string[];     // e.g., ['WETH', 'USDC', 'cbBTC']
  debtAssets: string[];           // e.g., ['WETH', 'USDC']
  collateralUSD: number;          // Total collateral value in USD
  debtUSD: number;                // Total debt value in USD
  estimatedHF: number;            // Health factor from subgraph
  lastCheckedHF: number;          // Last on-chain health factor
  lastUpdated: number;            // Timestamp of last check
  addedAt: number;                // Timestamp when added to pool
}

/**
 * UserPool manages a collection of users being monitored for liquidation
 * In-memory storage that gets cleared and refreshed after successful liquidations
 */
export class UserPool {
  private users: Map<string, TrackedUser>;
  
  constructor() {
    this.users = new Map();
  }

  /**
   * @notice Add a user to the tracking pool
   * @dev Normalizes address to lowercase and sets timestamps
   * @param user User data to track
   */
  addUser(user: TrackedUser): void {
    const address = user.address.toLowerCase();
    this.users.set(address, {
      ...user,
      address,
      addedAt: user.addedAt || Date.now(),
      lastUpdated: Date.now(),
    });
  }

  /**
   * @notice Remove a user from the tracking pool
   * @dev Logs removal action
   * @param address User address to remove
   * @return True if user was removed, false if not found
   */
  removeUser(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const removed = this.users.delete(normalizedAddress);
    if (removed) {
      logger.info(`Removed user ${normalizedAddress} from pool`);
    }
    return removed;
  }

  /**
   * @notice Get a specific user from the pool
   * @dev Returns undefined if user not found
   * @param address User address to retrieve
   * @return User data or undefined
   */
  getUser(address: string): TrackedUser | undefined {
    return this.users.get(address.toLowerCase());
  }

  /**
   * @notice Get all users in the pool
   * @dev Returns array of all tracked users
   * @return Array of tracked users
   */
  getAllUsers(): TrackedUser[] {
    return Array.from(this.users.values());
  }

  /**
   * @notice Get users that have a specific asset in their collateral
   * @dev Monitors collateral price drops (reduces HF)
   * @param assetSymbol Asset symbol to filter by
   * @return Array of users with specified collateral
   */
  getUsersWithCollateral(assetSymbol: string): TrackedUser[] {
    return this.getAllUsers().filter(user => 
      user.collateralAssets.includes(assetSymbol)
    );
  }

  /**
   * @notice Get users that have a specific asset in their debt
   * @dev Monitors debt price rises (reduces HF)
   * @param assetSymbol Asset symbol to filter by
   * @return Array of users with specified debt
   */
  getUsersWithDebt(assetSymbol: string): TrackedUser[] {
    return this.getAllUsers().filter(user => 
      user.debtAssets.includes(assetSymbol)
    );
  }

  /**
   * @notice Get unique collateral asset symbols across all tracked users
   * @dev Used for dynamic price monitoring - only subscribe to assets that users actually have
   * @return Array of unique collateral asset symbols
   */
  getUniqueCollateralAssets(): string[] {
    const uniqueAssets = new Set<string>();
    for (const user of this.getAllUsers()) {
      user.collateralAssets.forEach(asset => uniqueAssets.add(asset));
    }
    return Array.from(uniqueAssets);
  }

  /**
   * @notice Get unique debt asset symbols across all tracked users
   * @dev Used for price monitoring - debt price increases reduce HF
   * @return Array of unique debt asset symbols
   */
  getUniqueDebtAssets(): string[] {
    const uniqueAssets = new Set<string>();
    for (const user of this.getAllUsers()) {
      user.debtAssets.forEach(asset => uniqueAssets.add(asset));
    }
    return Array.from(uniqueAssets);
  }

  /**
   * @notice Get users with HF below a threshold (from last check)
   * @dev Sorts by health factor ascending (most risky first)
   * @param maxHF Maximum health factor threshold
   * @return Array of users sorted by HF
   */
  getUsersByHF(maxHF: number): TrackedUser[] {
    return this.getAllUsers()
      .filter(user => user.lastCheckedHF < maxHF)
      .sort((a, b) => a.lastCheckedHF - b.lastCheckedHF);
  }

  /**
   * @notice Update a user's on-chain health factor
   * @dev Updates lastCheckedHF and lastUpdated timestamp
   * @param address User address
   * @param healthFactor New health factor value
   */
  updateUserHF(address: string, healthFactor: number): void {
    const user = this.getUser(address);
    if (user) {
      user.lastCheckedHF = healthFactor;
      user.lastUpdated = Date.now();
    }
  }

  /**
   * @notice Clear all users from the pool
   * @dev Logs number of users cleared
   */
  clear(): void {
    const count = this.users.size;
    this.users.clear();
    logger.info(`Cleared ${count} users from pool`);
  }

  /**
   * @notice Get the number of users in the pool
   * @dev Returns current pool size
   * @return Number of tracked users
   */
  size(): number {
    return this.users.size;
  }

  /**
   * @notice Check if pool is empty
   * @dev Returns true if no users are tracked
   * @return True if pool is empty
   */
  isEmpty(): boolean {
    return this.users.size === 0;
  }

  /**
   * @notice Get summary statistics
   * @dev Calculates user counts by HF ranges and total USD values
   * @return Statistics object with counts and totals
   */
  getStats(): {
    totalUsers: number;
    liquidatable: number;
    critical: number;
    warning: number;
    healthy: number;
    totalCollateralUSD: number;
    totalDebtUSD: number;
  } {
    const allUsers = this.getAllUsers();
    return {
      totalUsers: allUsers.length,
      liquidatable: allUsers.filter(u => u.lastCheckedHF < 1.0).length,
      critical: allUsers.filter(u => u.lastCheckedHF >= 1.0 && u.lastCheckedHF < 1.05).length,
      warning: allUsers.filter(u => u.lastCheckedHF >= 1.03 && u.lastCheckedHF < 1.05).length,
      healthy: allUsers.filter(u => u.lastCheckedHF >= 1.1).length,
      totalCollateralUSD: allUsers.reduce((sum, u) => sum + u.collateralUSD, 0),
      totalDebtUSD: allUsers.reduce((sum, u) => sum + u.debtUSD, 0),
    };
  }

  /**
   * @notice Log current pool status
   * @dev Outputs detailed statistics to logger
   */
  logStatus(): void {
    const stats = this.getStats();
    logger.info('UserPool Status:');
    logger.info(`   Total Users: ${stats.totalUsers}`);
    logger.info(`   Liquidatable (HF < 1.0): ${stats.liquidatable}`);
    logger.info(`   Critical (HF 1.0-1.05): ${stats.critical}`);
    logger.info(`   At Risk (HF 1.05-1.1): ${stats.warning}`);
    logger.info(`   Healthy (HF >= 1.1): ${stats.healthy}`);
    logger.info(`   Total Collateral: $${stats.totalCollateralUSD.toFixed(2)}`);
    logger.info(`   Total Debt: $${stats.totalDebtUSD.toFixed(2)}`);
  }
}
