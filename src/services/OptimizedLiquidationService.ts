import { createPublicClient, http, parseAbi, Address, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { logger } from '../utils/logger';
import { UserHealth } from './HealthChecker';
import { PriceOracle } from './PriceOracle';
import { config } from '../config';

export interface UserReserveData {
  asset: string;
  symbol: string;
  decimals: number;
  collateralBalance: bigint;
  debtBalance: bigint;
  usageAsCollateralEnabled: boolean;
  liquidationBonus: number;
}

export interface LiquidationParams {
  userAddress: string;
  collateralAsset: string;
  collateralSymbol: string;
  debtAsset: string;
  debtSymbol: string;
  debtToCover: bigint;
  liquidationBonus: number;
  estimatedValue: number;
}

export class OptimizedLiquidationService {
  private protocolDataProvider: string;
  private poolAddress: string;
  private priceOracle: PriceOracle;
  private publicClient: any;
  
  private dataProviderAbi = parseAbi([
    'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  ]);

  private poolAbi = parseAbi([
    'function getUserConfiguration(address user) external view returns (uint256)',
  ]);

  private reservesTokensAbi = [
    {
      name: 'getAllReservesTokens',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        {
          name: '',
          type: 'tuple[]',
          components: [
            { name: 'symbol', type: 'string' },
            { name: 'tokenAddress', type: 'address' }
          ]
        }
      ]
    }
  ] as const;

  private reservesCache: Array<{ symbol: string; address: string }> | null = null;

  constructor(rpcUrl: string, protocolDataProvider: string) {
    this.protocolDataProvider = protocolDataProvider;
    this.poolAddress = config.aave.pool;
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });
    this.priceOracle = new PriceOracle(this.publicClient);
  }

  /**
   * @notice Decode getUserConfiguration bitmap to extract active reserve IDs
   * @dev Bitmap format: 2 bits per reserve (bit 0 = collateral enabled, bit 1 = borrowed)
   * @param bitmap User configuration bitmap from Aave Pool
   * @return Object containing collateral IDs, debt IDs, and all active IDs
   */
  private decodeBitmap(bitmap: bigint): { collateralIds: number[]; debtIds: number[]; allActiveIds: number[] } {
    const collateralIds: number[] = [];
    const debtIds: number[] = [];
    const allActiveIds: number[] = [];
    for (let i = 0; i < 128; i++) {
      const collateralBit = (bitmap >> BigInt(i * 2)) & BigInt(1);
      const borrowedBit = (bitmap >> BigInt(i * 2 + 1)) & BigInt(1);
      if (collateralBit === BigInt(1)) {
        collateralIds.push(i);
        if (!allActiveIds.includes(i)) allActiveIds.push(i);
      }
      if (borrowedBit === BigInt(1)) {
        debtIds.push(i);
        if (!allActiveIds.includes(i)) allActiveIds.push(i);
      }
    }
    logger.debug(
      `Decoded bitmap: ${allActiveIds.length} active reserves ` +
      `(${collateralIds.length} collateral, ${debtIds.length} debt)`
    );
    return { collateralIds, debtIds, allActiveIds };
  }

  /**
   * @notice Get all reserves from Aave Protocol Data Provider
   * @dev Results are cached after first fetch
   * @return Array of reserve symbols and addresses
   */
  private async getAllReserves(): Promise<Array<{ symbol: string; address: string }>> {
    if (this.reservesCache) {
      return this.reservesCache;
    }
    const result = await this.publicClient.readContract({
      address: this.protocolDataProvider as Address,
      abi: this.reservesTokensAbi,
      functionName: 'getAllReservesTokens',
    }) as Array<{ symbol: string; tokenAddress: string }>;
    this.reservesCache = result.map(r => ({
      symbol: r.symbol,
      address: r.tokenAddress,
    }));
    logger.debug(`Cached ${this.reservesCache.length} reserves`);
    return this.reservesCache;
  }

  /**
   * @notice Get user's active reserves with configuration data
   * @dev Optimized: Only fetches data for reserves user actually uses (via bitmap filtering)
   * @param userAddress Address of the user to query
   * @return Array of user's active reserves with balance and config data
   */
  async getUserReservesWithConfigs(userAddress: string): Promise<UserReserveData[]> {
    const bitmapResult = await this.publicClient.readContract({
      address: this.poolAddress as Address,
      abi: this.poolAbi,
      functionName: 'getUserConfiguration',
      args: [userAddress as Address],
    });
    const bitmap = bitmapResult as bigint;
    const { allActiveIds } = this.decodeBitmap(bitmap);
    if (allActiveIds.length === 0) {
      return [];
    }
    const allReserves = await this.getAllReserves();
    const contracts: any[] = [];
    const activeReserves: Array<{ id: number; symbol: string; address: string }> = [];
    for (const reserveId of allActiveIds) {
      if (reserveId >= allReserves.length) {
        logger.warn(`Reserve ID ${reserveId} out of bounds (max: ${allReserves.length - 1})`);
        continue;
      }
      const reserve = allReserves[reserveId];
      activeReserves.push({ id: reserveId, ...reserve });
      contracts.push({
        address: this.protocolDataProvider as Address,
        abi: this.dataProviderAbi,
        functionName: 'getUserReserveData',
        args: [reserve.address as Address, userAddress as Address],
      });
      contracts.push({
        address: this.protocolDataProvider as Address,
        abi: this.dataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [reserve.address as Address],
      });
    }

    const results = await this.publicClient.multicall({ contracts });
    const userReserves: UserReserveData[] = [];
    for (let i = 0; i < activeReserves.length; i++) {
      const userDataIndex = i * 2;
      const configDataIndex = i * 2 + 1;
      const userDataResult = results[userDataIndex];
      const configDataResult = results[configDataIndex];
      if (userDataResult.status !== 'success' || configDataResult.status !== 'success') {
        continue;
      }
      const userData = userDataResult.result as any[];
      const configData = configDataResult.result as any[];
      const collateralBalance = BigInt(userData[0].toString());
      const stableDebt = BigInt(userData[1].toString());
      const variableDebt = BigInt(userData[2].toString());
      const debtBalance = stableDebt + variableDebt;
      const usageAsCollateralEnabled = userData[8] as boolean;
      
      if (collateralBalance === 0n && debtBalance === 0n) {
        continue;
      }
      
      const decimals = Number(configData[0]);
      const liquidationBonusRaw = Number(configData[3]);
      const liquidationBonus = (liquidationBonusRaw - 10000) / 100;
      userReserves.push({
        asset: activeReserves[i].address,
        symbol: activeReserves[i].symbol,
        decimals,
        collateralBalance,
        debtBalance,
        usageAsCollateralEnabled,
        liquidationBonus,
      });
    }
    logger.info(
      `Found ${userReserves.length} reserves with balances ` +
      `(fetched ${activeReserves.length}/${allReserves.length} reserves, ` +
      `saved ${((1 - activeReserves.length / allReserves.length) * 100).toFixed(1)}% RPC calls)`
    );
    return userReserves;
  }

  async selectBestPair(
    userReserves: UserReserveData[]
  ): Promise<{ collateral: UserReserveData; debt: UserReserveData } | null> {
    const collaterals = userReserves.filter(
      r => r.collateralBalance > 0n && 
           r.usageAsCollateralEnabled &&
           r.liquidationBonus > 0
    );
    const debts = userReserves.filter(r => r.debtBalance > 0n);
    if (collaterals.length === 0 || debts.length === 0) {
      return null;
    }
    const allAssets = [...collaterals, ...debts].map(r => r.asset);
    const uniqueAssets = [...new Set(allAssets)];
    const priceMap = await this.priceOracle.getAssetsPrices(uniqueAssets);
    const validPairs: Array<{ collateral: UserReserveData; debt: UserReserveData; bonus: number }> = [];
    for (const collateral of collaterals) {
      for (const debt of debts) {
        const collateralPrice = priceMap.get(collateral.asset);
        const debtPrice = priceMap.get(debt.asset);
        if (!collateralPrice || !debtPrice) {
          continue;
        }
        const collateralAmount = parseFloat(
          formatUnits(collateral.collateralBalance, collateral.decimals)
        );
        const debtAmount = parseFloat(
          formatUnits(debt.debtBalance, debt.decimals)
        );
        const collateralValueUSD = collateralAmount * collateralPrice;
        const debtValueUSD = debtAmount * debtPrice;
        const debtToRepayUSD = debtValueUSD * 0.5;
        const requiredCollateralUSD = debtToRepayUSD * (1 + collateral.liquidationBonus / 100);
        if (collateralValueUSD >= requiredCollateralUSD) {
          validPairs.push({
            collateral,
            debt,
            bonus: collateral.liquidationBonus
          });
        }
      }
    }
    if (validPairs.length === 0) {
      logger.warn('No valid pairs with sufficient collateral found');
      return null;
    }
    const bestPair = validPairs.reduce((best, current) => 
      current.bonus > best.bonus ? current : best
    );
    logger.info(
      `Selected: ${bestPair.collateral.symbol}-${bestPair.debt.symbol} ` +
      `(${validPairs.length} valid pairs, bonus: ${bestPair.bonus}%)`
    );
    return {
      collateral: bestPair.collateral,
      debt: bestPair.debt
    };
  }

  /**
   * @notice Prepare liquidation parameters with collateral constraint
   * @dev Aave V3 handles close factor internally (50%/100% based on HF), bot only needs collateral limit
   * @param userAddress Address of user to liquidate
   * @param collateral Collateral reserve data from protocol
   * @param debt Debt reserve data from protocol
   * @param healthFactor User's current health factor
   * @return Complete liquidation parameters for execution
   */
  async prepareLiquidationParams(
    userAddress: string,
    collateral: UserReserveData,
    debt: UserReserveData,
    healthFactor: number
  ): Promise<LiquidationParams | null> {
    const totalDebt = debt.debtBalance;
    const priceMap = await this.priceOracle.getAssetsPrices([collateral.asset, debt.asset]);
    const collateralPrice = priceMap.get(collateral.asset);
    const debtPrice = priceMap.get(debt.asset);

    if (!collateralPrice || !debtPrice) {
      logger.error('Cannot get prices for liquidation calculation');
      return null;
    }
    const collateralAmount = parseFloat(
      formatUnits(collateral.collateralBalance, collateral.decimals)
    );
    const collateralValueUSD = collateralAmount * collateralPrice;
    const liquidationBonusMultiplier = 1 + (collateral.liquidationBonus / 100);
    const maxDebtValueUSD = collateralValueUSD / liquidationBonusMultiplier;
    const maxDebtByCollateral = maxDebtValueUSD / debtPrice;
    const maxDebtByCollateralBN = BigInt(
      Math.floor(maxDebtByCollateral * 10 ** debt.decimals)
    );
    const debtToCover = totalDebt < maxDebtByCollateralBN 
      ? totalDebt 
      : maxDebtByCollateralBN;
    if (debtToCover === 0n) {
      logger.warn('Calculated debtToCover is 0, skipping liquidation');
      return null;
    }
    const debtValue = parseFloat(formatUnits(debtToCover, debt.decimals));
    const estimatedValue = debtValue * liquidationBonusMultiplier;

    logger.info(
      `Liquidation calc: totalDebt=${formatUnits(totalDebt, debt.decimals)}, ` +
      `maxByCollateral=${maxDebtByCollateral.toFixed(4)}, ` +
      `final=${formatUnits(debtToCover, debt.decimals)} ${debt.symbol}`
    );
    
    return {
      userAddress,
      collateralAsset: collateral.asset,
      collateralSymbol: collateral.symbol,
      debtAsset: debt.asset,
      debtSymbol: debt.symbol,
      debtToCover,
      liquidationBonus: collateral.liquidationBonus,
      estimatedValue,
    };
  }

  /**
   * @notice Get complete liquidation parameters for a user
   * @dev Orchestrates: bitmap filtering → data fetching → pair selection → param preparation
   * @param userHealth User's health data including address and health factor
   * @return Complete liquidation parameters, or null if no suitable opportunity
   */
  async getLiquidationParams(
    userHealth: UserHealth
  ): Promise<LiquidationParams | null> {
    const userReserves = await this.getUserReservesWithConfigs(userHealth.user);
    if (userReserves.length === 0) {
      return null;
    }
    const bestPair = await this.selectBestPair(userReserves);
    if (!bestPair) {
      return null;
    }
    const params = this.prepareLiquidationParams(
      userHealth.user,
      bestPair.collateral,
      bestPair.debt,
      userHealth.healthFactor
    );
    return params;
  }
}
