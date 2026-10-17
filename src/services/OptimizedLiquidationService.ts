import { parseAbi, Address, formatUnits } from 'viem';
import { logger } from '../utils/logger';
import { UserHealth } from './HealthChecker';
import { PriceOracle } from './PriceOracle';
import { config } from '../config';

import { AssetManager } from './AssetManager';
import { SmartRouter } from './SmartRouter';

export interface UserReserveData {
  asset: string;
  symbol: string;
  decimals: number;
  collateralBalance: bigint;
  debtBalance: bigint;
  usageAsCollateralEnabled: boolean;
  liquidationBonus: number;
  liquidationProtocolFee: number;
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
  estimatedCollateralAmount?: bigint;
  swapPath?: `0x${string}`;
}

export class OptimizedLiquidationService {
  private protocolDataProvider: string;
  private poolAddress: string;
  private priceOracle: PriceOracle;
  private publicClient: any;
  private readonly BASE_CURRENCY_DECIMALS = 8;
  private readonly MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 200000000000; // 2000e8 ($2000)
  private readonly MIN_LEFTOVER_BASE = 100000000000; // 1000e8 ($1000)
  private readonly MIN_LIQUIDATION_VALUE_USD = 100;
  private readonly CLOSE_FACTOR_HF_THRESHOLD = 0.95;
  private readonly DEFAULT_LIQUIDATION_CLOSE_FACTOR = 0.5;
  
  private dataProviderAbi = parseAbi([
    'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  ]);

  private poolAbi = parseAbi([
    'function getUserConfiguration(address user) external view returns (uint256)',
  ]);


  private assetManager: AssetManager;
  private smartRouter?: SmartRouter;

  constructor(
    publicClient: any,
    protocolDataProvider: string,
    assetManager: AssetManager,
    smartRouter?: SmartRouter
  ) {
    this.protocolDataProvider = protocolDataProvider;
    this.poolAddress = config.aave.pool;
    this.publicClient = publicClient;
    this.priceOracle = new PriceOracle(this.publicClient);
    this.assetManager = assetManager;
    this.smartRouter = smartRouter;
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



  selectBestPair(
    userReserves: UserReserveData[],
    priceCache: Map<string, number>
  ): { collateral: UserReserveData; debt: UserReserveData } | null {
    const collaterals = userReserves.filter(
      r => r.collateralBalance > 0n && r.usageAsCollateralEnabled && r.liquidationBonus > 0
    );
    const debts = userReserves.filter(r => r.debtBalance > 0n);
    if (collaterals.length === 0 || debts.length === 0) {
      return null;
    }
    const validPairs: Array<{
      collateral: UserReserveData;
      debt: UserReserveData;
      bonus: number;
      estimatedValue: number;
    }> = [];
    for (const collateral of collaterals) {
      for (const debt of debts) {
        const collateralPrice = priceCache.get(collateral.asset);
        const debtPrice = priceCache.get(debt.asset);
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
        const liquidationBonusMultiplier = 1 + (collateral.liquidationBonus / 100);
        const maxDebtValueUSD = collateralValueUSD / liquidationBonusMultiplier;
        const maxDebtToCoverUSD = Math.min(debtValueUSD, maxDebtValueUSD);
        if (maxDebtToCoverUSD >= 10) {
          validPairs.push({
            collateral,
            debt,
            bonus: collateral.liquidationBonus,
            estimatedValue: maxDebtToCoverUSD * liquidationBonusMultiplier,
          });
        }
      }
    }
    if (validPairs.length === 0) {
      logger.warn('No valid pairs with sufficient collateral found');
      return null;
    }
    const bestPair = validPairs.reduce((best, current) =>
      current.estimatedValue > best.estimatedValue ? current : best
    );
    logger.info(
      `Selected: ${bestPair.collateral.symbol}-${bestPair.debt.symbol} ` +
      `(${validPairs.length} valid pairs, value: $${bestPair.estimatedValue.toFixed(2)}, bonus: ${bestPair.bonus}%)`
    );
    return {
      collateral: bestPair.collateral,
      debt: bestPair.debt
    };
  }

  /**
   * @notice Prepare liquidation parameters with collateral constraint, Aave v3.3 close factor, and dust prevention
   * @dev Close factor is 100% by default. The 50% cap applies only when the collateral and debt of this reserve
   *      are both >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD ($2000) and health factor > CLOSE_FACTOR_HF_THRESHOLD (0.95),
   *      in which case the cap is 50% of the user's total position debt. On partial liquidation, both leftover debt and
   *      leftover collateral are forced to stay >= MIN_LEFTOVER_BASE ($1000) to satisfy Aave v3.3 MustNotLeaveDust.
   *      The estimated value and collateral amount are net of the Aave liquidation protocol fee, which is taken as a
   *      percentage of the bonus portion of the seized collateral (getLiquidationProtocolFee, e.g. 10% on Base).
   * @param userAddress Address of user to liquidate
   * @param collateral Collateral reserve data
   * @param debt Debt reserve data
   * @param priceCache Pre-fetched price map for calculation
   * @param userHealthFactor Health factor of the target user
   * @param resolveRoute Whether to resolve the Uniswap swap route immediately
   * @param totalDebtBase User's total position debt in base currency (8 decimals), used for the 50% close factor cap
   * @return Complete liquidation parameters or null if invalid
   */
  async prepareLiquidationParams(
    userAddress: string,
    collateral: UserReserveData,
    debt: UserReserveData,
    priceCache: Map<string, number>,
    userHealthFactor: number = 1.0,
    resolveRoute: boolean = false,
    totalDebtBase: bigint = 0n
  ): Promise<LiquidationParams | null> {
    const collateralPrice = priceCache.get(collateral.asset);
    const debtPrice = priceCache.get(debt.asset);
    if (!collateralPrice || !debtPrice) {
      logger.error('Cannot get prices for liquidation calculation');
      return null;
    }
    const collateralAmount = parseFloat(formatUnits(collateral.collateralBalance, collateral.decimals));
    const collateralValueUSD = collateralAmount * collateralPrice;
    const liquidationBonusMultiplier = 1 + (collateral.liquidationBonus / 100);
    const maxDebtValueUSD = collateralValueUSD / liquidationBonusMultiplier;
    const maxDebtByCollateral = maxDebtValueUSD / debtPrice;
    const maxDebtByCollateralBN = BigInt(Math.floor(maxDebtByCollateral * 10 ** debt.decimals));

    const totalDebtFloat = parseFloat(formatUnits(debt.debtBalance, debt.decimals));
    const debtReserveBase = Math.floor(totalDebtFloat * debtPrice * 10 ** this.BASE_CURRENCY_DECIMALS);
    const collateralReserveBase = Math.floor(collateralValueUSD * 10 ** this.BASE_CURRENCY_DECIMALS);

    let maxProtocolDebt = debt.debtBalance;

    const closeFactorCapApplies =
      collateralReserveBase >= this.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
      debtReserveBase >= this.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
      userHealthFactor > this.CLOSE_FACTOR_HF_THRESHOLD;

    if (closeFactorCapApplies) {
      const totalDebtBaseNum = totalDebtBase > 0n ? Number(totalDebtBase) : debtReserveBase;
      const defaultLiquidatableBase = totalDebtBaseNum * this.DEFAULT_LIQUIDATION_CLOSE_FACTOR;
      if (debtReserveBase > defaultLiquidatableBase) {
        const maxDebtByCloseFactor = (defaultLiquidatableBase / 10 ** this.BASE_CURRENCY_DECIMALS) / debtPrice;
        maxProtocolDebt = BigInt(Math.floor(maxDebtByCloseFactor * 10 ** debt.decimals));
      }
    }

    let debtToCover = collateral.collateralBalance === 0n
      ? 0n
      : (maxProtocolDebt < maxDebtByCollateralBN ? maxProtocolDebt : maxDebtByCollateralBN);

    if (debtToCover === 0n) {
      logger.warn('Calculated debtToCover is 0, skipping liquidation');
      return null;
    }
    let debtToCoverFloat = parseFloat(formatUnits(debtToCover, debt.decimals));

    if (debtToCover < debt.debtBalance) {
      const collateralToSeizeUSD = debtToCoverFloat * debtPrice * liquidationBonusMultiplier;
      const collateralToSeize = collateralToSeizeUSD / collateralPrice;
      const debtLeftover = totalDebtFloat - debtToCoverFloat;
      const collateralLeftover = collateralAmount - collateralToSeize;
      const debtLeftoverBase = Math.ceil(debtLeftover * debtPrice * (10 ** this.BASE_CURRENCY_DECIMALS));
      const collateralLeftoverBase = Math.ceil(collateralLeftover * collateralPrice * (10 ** this.BASE_CURRENCY_DECIMALS));

      const collateralFullyConsumed = collateralLeftover <= 0;
      if (!collateralFullyConsumed &&
          (debtLeftoverBase < this.MIN_LEFTOVER_BASE || collateralLeftoverBase < this.MIN_LEFTOVER_BASE)) {
        const minLeftoverUSD = this.MIN_LEFTOVER_BASE / 10 ** this.BASE_CURRENCY_DECIMALS;
        const maxDebtByDebtLeftover = totalDebtFloat - (minLeftoverUSD / debtPrice);
        const maxDebtByCollateralLeftover =
          ((collateralValueUSD - minLeftoverUSD) / liquidationBonusMultiplier) / debtPrice;
        let adjustedDebtToCover = Math.min(maxDebtByDebtLeftover, maxDebtByCollateralLeftover);
        let adjustedDebtToCoverBN = BigInt(Math.floor(adjustedDebtToCover * 10 ** debt.decimals));
        if (adjustedDebtToCoverBN > maxProtocolDebt) {
          adjustedDebtToCoverBN = maxProtocolDebt;
          adjustedDebtToCover = parseFloat(formatUnits(adjustedDebtToCoverBN, debt.decimals));
        }
        if (adjustedDebtToCoverBN <= 0n) {
          logger.warn('MustNotLeaveDust: cannot satisfy $1000 leftover on both sides, skipping liquidation');
          return null;
        }
        debtToCover = adjustedDebtToCoverBN;
        debtToCoverFloat = adjustedDebtToCover;
        logger.info(`Adjusted for MustNotLeaveDust (v3.3, $1000 floor): debtLeftover=$${(debtLeftoverBase / 1e8).toFixed(2)}, collateralLeftover=$${(collateralLeftoverBase / 1e8).toFixed(2)}`);
      }
    }
    if (debtToCover === 0n) {
      logger.warn('Adjusted debtToCover is 0 after MustNotLeaveDust check, skipping liquidation');
      return null;
    }
    const debtToCoverUSD = debtToCoverFloat * debtPrice;
    const grossCollateralUSD = debtToCoverUSD * liquidationBonusMultiplier;
    const bonusCollateralUSD = grossCollateralUSD - grossCollateralUSD / liquidationBonusMultiplier;
    const protocolFeeUSD = bonusCollateralUSD * (collateral.liquidationProtocolFee / 100);
    const estimatedValueUSD = grossCollateralUSD - protocolFeeUSD;
    logger.info(`Liquidation calc: totalDebt=${formatUnits(debt.debtBalance, debt.decimals)}, maxProtocolDebt=${formatUnits(maxProtocolDebt, debt.decimals)} (HF: ${userHealthFactor.toFixed(4)}), maxByCollateral=${maxDebtByCollateral.toFixed(4)}, final=${formatUnits(debtToCover, debt.decimals)} ${debt.symbol} ($${debtToCoverUSD.toFixed(2)}), protocolFee=$${protocolFeeUSD.toFixed(2)}, netValue=$${estimatedValueUSD.toFixed(2)}`);

    const estimatedCollateralAmount = BigInt(
      Math.floor((estimatedValueUSD / collateralPrice) * (10 ** collateral.decimals))
    );

    const params: LiquidationParams = {
      userAddress,
      collateralAsset: collateral.asset,
      collateralSymbol: collateral.symbol,
      debtAsset: debt.asset,
      debtSymbol: debt.symbol,
      debtToCover,
      debtToCoverUSD,
      liquidationBonus: collateral.liquidationBonus,
      estimatedValue: estimatedValueUSD,
      estimatedCollateralAmount,
    };

    if (resolveRoute) {
      await this.attachSwapRoute(params);
    }

    return params;
  }

  /**
   * @notice Attach Uniswap V3 swap path to the liquidation parameters on-demand
   * @dev Called ONLY for the single chosen liquidation pair right before execution
   */
  async attachSwapRoute(params: LiquidationParams): Promise<LiquidationParams> {
    if (params.collateralAsset.toLowerCase() === params.debtAsset.toLowerCase()) {
      params.swapPath = '0x';
      return params;
    }

    if (!this.smartRouter) {
      return params;
    }

    try {
      const amountToSwap = (params.estimatedCollateralAmount && params.estimatedCollateralAmount > 0n)
        ? params.estimatedCollateralAmount
        : 1000n;

      const route = await this.smartRouter.getBestRoute(
        params.collateralAsset,
        params.debtAsset,
        amountToSwap
      );

      if (route && route.path && route.path !== '0x') {
        params.swapPath = route.path;
      }
    } catch (err: any) {
      logger.warn(
        `Failed to get route from SmartRouter for ${params.collateralSymbol} -> ${params.debtSymbol}: ${err.message}`
      );
    }

    return params;
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
    const allReserves = this.assetManager.getAllReserves();
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
        const config = this.assetManager.getAssetConfig(reserve.address);
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
          liquidationProtocolFee: config.liquidationProtocolFee,
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
      const bestPair = this.selectBestPair(userReserves, priceCache);
      if (!bestPair) continue;
      const params = await this.prepareLiquidationParams(
        userHealth.user,
        bestPair.collateral,
        bestPair.debt,
        priceCache,
        userHealth.healthFactor,
        false,
        userHealth.totalDebtBase
      );
      if (params && params.estimatedValue >= this.MIN_LIQUIDATION_VALUE_USD) {
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
