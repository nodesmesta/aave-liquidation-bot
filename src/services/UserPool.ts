import { logger } from '../utils/logger';

export interface TrackedUser {
  address: string;
  collateralAssets: string[];
  debtAssets: string[];
  collateralUSD: number;
  debtUSD: number;
  estimatedHF: number;
  lastCheckedHF: number;
  lastUpdated: number;
  addedAt: number;
}

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
   * @notice Update a user's on-chain health factor
   * @dev Updates lastCheckedHF and lastUpdated timestamp
   * @param address User address
   * @param healthFactor New health factor value
   */
  updateUserHF(address: string, healthFactor: number): void {
    const user = this.users.get(address.toLowerCase());
    if (user) {
      user.lastCheckedHF = healthFactor;
      user.lastUpdated = Date.now();
    }
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
    logger.info(`Pool: ${stats.totalUsers} users (${stats.liquidatable} liquidatable, ${stats.critical} critical) | TVL $${(stats.totalCollateralUSD / 1000).toFixed(0)}K/$${(stats.totalDebtUSD / 1000).toFixed(0)}K`);
  }
}
