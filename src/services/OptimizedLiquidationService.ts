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
  debtToCoverUSD: number;
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
  private reserveConfigCache: Map<string, { decimals: number; liquidationBonus: number }> = new Map();

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
   * @return Array of active reserve IDs
   */
  private decodeBitmap(bitmap: bigint): number[] {
    const allActiveIds: number[] = [];
    for (let i = 0; i < 128; i++) {
      const hasBits = (bitmap >> BigInt(i * 2)) & BigInt(3);
      if (hasBits > 0n) {
        allActiveIds.push(i);
      }
    }
    return allActiveIds;
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
   * @notice Warmup reserve config cache by pre-fetching all reserves
   * @dev Called during bot initialization, cache refreshed on bot restart
   */
  async warmupConfigCache(): Promise<void> {
    const allReserves = await this.getAllReserves();
    const allAssetAddresses = allReserves.map(r => r.address);
    
    const configContracts = allAssetAddresses.map(asset => ({
      address: this.protocolDataProvider as Address,
      abi: this.dataProviderAbi,
      functionName: 'getReserveConfigurationData',
      args: [asset as Address],
    }));
    
    const results = await this.publicClient.multicall({ contracts: configContracts });
    
    for (let i = 0; i < allAssetAddresses.length; i++) {
      const result = results[i];
      if (result.status === 'success') {
        const configData = result.result as any[];
        const decimals = Number(configData[0]);
        const liquidationBonusRaw = Number(configData[3]);
        const liquidationBonus = (liquidationBonusRaw - 10000) / 100;
        
        this.reserveConfigCache.set(allAssetAddresses[i], { decimals, liquidationBonus });
      }
    }
    
    logger.info(`Reserve config cache warmed up: ${this.reserveConfigCache.size} assets cached`);
  }

  async selectBestPair(
    userReserves: UserReserveData[],
    priceCache?: Map<string, number>
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
    
    let priceMap: Map<string, number>;
    if (priceCache) {
      priceMap = priceCache;
    } else {
      const allAssets = [...collaterals, ...debts].map(r => r.asset);
      const uniqueAssets = [...new Set(allAssets)];
      priceMap = await this.priceOracle.getAssetsPrices(uniqueAssets);
    }
    const validPairs: Array<{ 
      collateral: UserReserveData; 
      debt: UserReserveData; 
      bonus: number;
      estimatedValue: number;
      estimatedProfit: number;
    }> = [];
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
        
        // Calculate max debt that can be covered by available collateral
        const liquidationBonusMultiplier = 1 + (collateral.liquidationBonus / 100);
        const maxDebtValueUSD = collateralValueUSD / liquidationBonusMultiplier;
        const maxDebtToCoverUSD = Math.min(debtValueUSD, maxDebtValueUSD);
        
        // Only consider pairs where we can liquidate at least $10 of debt
        if (maxDebtToCoverUSD >= 10) {
          const estimatedProfitUSD = maxDebtToCoverUSD * (collateral.liquidationBonus / 100);
          validPairs.push({
            collateral,
            debt,
            bonus: collateral.liquidationBonus,
            estimatedValue: maxDebtToCoverUSD * liquidationBonusMultiplier,
            estimatedProfit: estimatedProfitUSD
          });
        }
      }
    }
    if (validPairs.length === 0) {
      logger.warn('No valid pairs with sufficient collateral found');
      return null;
    }
    
    // Select pair with highest estimated value (profit potential)
    const bestPair = validPairs.reduce((best, current) => 
      current.estimatedValue > best.estimatedValue ? current : best
    );
    
    logger.info(
      `Selected: ${bestPair.collateral.symbol}-${bestPair.debt.symbol} ` +
      `(${validPairs.length} valid pairs, value: $${bestPair.estimatedValue.toFixed(2)}, ` +
      `profit: $${bestPair.estimatedProfit.toFixed(2)}, bonus: ${bestPair.bonus}%)`
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
   * @param priceCache Optional pre-fetched price map to avoid redundant RPC calls
   * @return Complete liquidation parameters for execution
   */
  async prepareLiquidationParams(
    userAddress: string,
    collateral: UserReserveData,
    debt: UserReserveData,
    healthFactor: number,
    priceCache?: Map<string, number>
  ): Promise<LiquidationParams | null> {
    const totalDebt = debt.debtBalance;
    let priceMap: Map<string, number>;
    if (priceCache) {
      priceMap = priceCache;
    } else {
      priceMap = await this.priceOracle.getAssetsPrices([collateral.asset, debt.asset]);
    }
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
    let debtToCover = totalDebt < maxDebtByCollateralBN 
      ? totalDebt 
      : maxDebtByCollateralBN;
    if (debtToCover === 0n) {
      logger.warn('Calculated debtToCover is 0, skipping liquidation');
      return null;
    }
    const BASE_CURRENCY_DECIMALS = 8;
    const MIN_LEFTOVER_BASE = 100000000;
    const SAFETY_MARGIN = 1.1;
    const totalDebtFloat = parseFloat(formatUnits(totalDebt, debt.decimals));
    let debtToCoverFloat = parseFloat(formatUnits(debtToCover, debt.decimals));
    if (debtToCover < totalDebt) {
      const collateralToSeizeUSD = debtToCoverFloat * debtPrice * liquidationBonusMultiplier;
      const collateralToSeize = collateralToSeizeUSD / collateralPrice;
      if (collateralToSeize < collateralAmount) {
        const debtLeftover = totalDebtFloat - debtToCoverFloat;
        const collateralLeftover = collateralAmount - collateralToSeize;
        const debtLeftoverBase = Math.ceil(debtLeftover * debtPrice * (10 ** BASE_CURRENCY_DECIMALS));
        const collateralLeftoverBase = Math.ceil(collateralLeftover * collateralPrice * (10 ** BASE_CURRENCY_DECIMALS));
        const isDebtMoreThanThreshold = debtLeftoverBase >= MIN_LEFTOVER_BASE;
        const isCollateralMoreThanThreshold = collateralLeftoverBase >= MIN_LEFTOVER_BASE;
        if (!isDebtMoreThanThreshold || !isCollateralMoreThanThreshold) {
          const targetLeftoverUSD = SAFETY_MARGIN;
          const maxDebtByDebtLeftover = totalDebtFloat - (targetLeftoverUSD / debtPrice);
          const maxDebtByCollateralLeftover = ((collateralValueUSD - targetLeftoverUSD) / liquidationBonusMultiplier) / debtPrice;
          const adjustedDebtToCover = Math.min(maxDebtByDebtLeftover, maxDebtByCollateralLeftover);
          debtToCover = BigInt(Math.floor(adjustedDebtToCover * 10 ** debt.decimals));
          debtToCoverFloat = adjustedDebtToCover;
          logger.info(
            `Adjusted for MustNotLeaveDust: debtLeftover=$${(debtLeftoverBase / 1e8).toFixed(2)}, ` +
            `collateralLeftover=$${(collateralLeftoverBase / 1e8).toFixed(2)} ` +
            `-> adjusted to leave >= $${targetLeftoverUSD}`
          );
        }
      }
    }
    if (debtToCover === 0n) {
      logger.warn('Adjusted debtToCover is 0 after MustNotLeaveDust check, skipping liquidation');
      return null;
    }
    const debtValue = debtToCoverFloat;
    const debtToCoverUSD = debtValue * debtPrice;
    const estimatedValueUSD = debtToCoverUSD * liquidationBonusMultiplier;

    logger.info(
      `Liquidation calc: totalDebt=${formatUnits(totalDebt, debt.decimals)}, ` +
      `maxByCollateral=${maxDebtByCollateral.toFixed(4)}, ` +
      `final=${formatUnits(debtToCover, debt.decimals)} ${debt.symbol} ($${debtToCoverUSD.toFixed(2)})`
    );
    
    return {
      userAddress,
      collateralAsset: collateral.asset,
      collateralSymbol: collateral.symbol,
      debtAsset: debt.asset,
      debtSymbol: debt.symbol,
      debtToCover,
      debtToCoverUSD,
      liquidationBonus: collateral.liquidationBonus,
      estimatedValue: estimatedValueUSD,
    };
  }
  /**
   * @notice Get liquidation params for multiple users in parallel using multicall
   * @dev Optimized: Fetches bitmaps + prices in 1 multicall, then reserves in 2nd multicall
   * @param users Array of user health data
   * @return Map of user address to liquidation params (only includes valid liquidations)
   */
  async getLiquidationParamsForMultipleUsers(
    users: UserHealth[]
  ): Promise<Map<string, { params: LiquidationParams; userHealth: UserHealth }>> {
    if (users.length === 0) return new Map();
    const startTime = Date.now();
    const allReserves = await this.getAllReserves();
    const bitmapContracts = users.map(user => ({
      address: this.poolAddress as Address,
      abi: this.poolAbi,
      functionName: 'getUserConfiguration',
      args: [user.user as Address],
    }));
    const bitmapResults = await this.publicClient.multicall({ contracts: bitmapContracts });
    const reserveDataContracts: any[] = [];
    const allActiveAssets = new Set<string>();
    const userReserveMap: Map<string, { ids: number[]; startIndex: number; count: number }> = new Map();
    let currentIndex = 0;
    for (let i = 0; i < users.length; i++) {
      const bitmapResult = bitmapResults[i];
      if (bitmapResult.status !== 'success') continue;
      const bitmap = bitmapResult.result as bigint;
      const allActiveIds = this.decodeBitmap(bitmap);
      if (allActiveIds.length === 0) continue;
      const validIds = allActiveIds.filter(id => id < allReserves.length);
      if (validIds.length === 0) continue;
      userReserveMap.set(users[i].user, {
        ids: validIds,
        startIndex: currentIndex,
        count: validIds.length,
      });
      for (const reserveId of validIds) {
        const reserve = allReserves[reserveId];
        allActiveAssets.add(reserve.address);
        reserveDataContracts.push({
          address: this.protocolDataProvider as Address,
          abi: this.dataProviderAbi,
          functionName: 'getUserReserveData',
          args: [reserve.address as Address, users[i].user as Address],
        });
      }
      currentIndex += validIds.length;
    }
    if (reserveDataContracts.length === 0) {
      logger.debug('No active reserves found for any user');
      return new Map();
    }
    const priceContract = {
      address: this.priceOracle['AAVE_ORACLE'] as Address,
      abi: this.priceOracle['ORACLE_ABI'],
      functionName: 'getAssetsPrices',
      args: [[...allActiveAssets] as `0x${string}`[]],
    };
    const combinedResults = await this.publicClient.multicall({ 
      contracts: [...reserveDataContracts, priceContract]
    });
    const reserveDataResults = combinedResults.slice(0, reserveDataContracts.length);
    const pricesResult = combinedResults[reserveDataContracts.length];
    let priceCache = new Map<string, number>();
    if (pricesResult.status === 'success') {
      const prices = pricesResult.result as bigint[];
      const assetArray = [...allActiveAssets];
      assetArray.forEach((asset, index) => {
        const price = parseFloat(formatUnits(prices[index], 8));
        priceCache.set(asset, price);
      });
    }
    const allUserReservesMap = new Map<string, UserReserveData[]>();
    for (const userHealth of users) {
      const userMapping = userReserveMap.get(userHealth.user);
      if (!userMapping) continue;
      const userReserves: UserReserveData[] = [];
      for (let i = 0; i < userMapping.ids.length; i++) {
        const reserveId = userMapping.ids[i];
        const userDataIndex = userMapping.startIndex + i;
        const userDataResult = reserveDataResults[userDataIndex];
        if (userDataResult.status !== 'success') {
          continue;
        }
        const userData = userDataResult.result as any[];
        const collateralBalance = BigInt(userData[0].toString());
        const stableDebt = BigInt(userData[1].toString());
        const variableDebt = BigInt(userData[2].toString());
        const debtBalance = stableDebt + variableDebt;
        const usageAsCollateralEnabled = userData[8] as boolean;
        if (collateralBalance === 0n && debtBalance === 0n) continue;
        const reserve = allReserves[reserveId];
        const config = this.reserveConfigCache.get(reserve.address);
        if (!config) {
          logger.warn(`Config not found for ${reserve.symbol}, skipping`);
          continue;
        }
        userReserves.push({
          asset: reserve.address,
          symbol: reserve.symbol,
          decimals: config.decimals,
          collateralBalance,
          debtBalance,
          usageAsCollateralEnabled,
          liquidationBonus: config.liquidationBonus,
        });
      }
      if (userReserves.length > 0) {
        allUserReservesMap.set(userHealth.user, userReserves);
      }
    }
    const resultMap = new Map<string, { params: LiquidationParams; userHealth: UserHealth }>();
    for (const userHealth of users) {
      const userReserves = allUserReservesMap.get(userHealth.user);
      if (!userReserves) continue;
      const bestPair = await this.selectBestPair(userReserves, priceCache);
      if (!bestPair) continue;
      const params = await this.prepareLiquidationParams(
        userHealth.user,
        bestPair.collateral,
        bestPair.debt,
        userHealth.healthFactor,
        priceCache
      );
      if (params && params.estimatedValue >= 100) {
        resultMap.set(userHealth.user, { params, userHealth });
      }
    }
    const elapsed = Date.now() - startTime;
    logger.info(
      `Parallel fetch complete: ${users.length} users, ${resultMap.size} valid liquidations, ` +
      `${allActiveAssets.size} active assets, ${reserveDataContracts.length} user reserves fetched in ${elapsed}ms`
    );
    return resultMap;
  }
}
