import { parseAbi, Address, formatUnits } from 'viem';
import { logger } from '../utils/logger';
import { UserHealth } from './HealthChecker';
import { PriceOracle } from './PriceOracle';
import { config } from '../config';
import { AAVE, HF_RAW, formatHF, percentMul, percentDiv } from '../config/thresholds';

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
  /** Raw liquidation bonus in bps (e.g. 10500 = 5% bonus). Derived from `liquidationBonus` when omitted. */
  liquidationBonusBps?: number;
  /** Raw liquidation protocol fee in bps (e.g. 1000 = 10% of the bonus). Derived when omitted. */
  liquidationProtocolFeeBps?: number;
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
  private readonly BASE_CURRENCY_DECIMALS = AAVE.BASE_CURRENCY_DECIMALS;
  private readonly MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = AAVE.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD;
  private readonly MIN_LEFTOVER_BASE = AAVE.MIN_LEFTOVER_BASE;
  private readonly MIN_LIQUIDATION_VALUE_USD = AAVE.MIN_LIQUIDATION_VALUE_USD;
  private readonly CLOSE_FACTOR_HF_THRESHOLD = AAVE.CLOSE_FACTOR_HF_THRESHOLD;
  private readonly DEFAULT_LIQUIDATION_CLOSE_FACTOR = AAVE.DEFAULT_LIQUIDATION_CLOSE_FACTOR;
  
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
      r => r.collateralBalance > 0n &&
        r.usageAsCollateralEnabled &&
        r.liquidationBonus > 0 &&
        // Aave reverts when the collateral reserve is inactive, frozen or paused.
        this.assetManager.isReserveLiquidatable(r.asset)
    );
    const debts = userReserves.filter(
      r => r.debtBalance > 0n && this.assetManager.isReserveLiquidatable(r.asset)
    );
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
   * @notice Convert a USD price (8-decimal oracle value held as a number) to an exact bigint
   * @dev Oracle prices are integers scaled by 1e8, so `price * 1e8` is exact for any realistic
   *      asset price (well below 2^53). This removes float error from every downstream product.
   */
  private priceToBase(price: number): bigint {
    return BigInt(Math.round(price * 1e8));
  }

  /**
   * @notice Prepare liquidation parameters with collateral constraint, Aave v3.3 close factor, and dust prevention
   * @dev Faithful bigint port of `LiquidationLogic.executeLiquidationCall` +
   *      `_calculateAvailableCollateralToLiquidate`. No float arithmetic is used for any amount,
   *      so `debtToCover` and the dust check match the on-chain result exactly instead of drifting
   *      by a few wei (which previously caused avoidable `MustNotLeaveDust` reverts).
   *      Close factor is 100% by default. The 50% cap applies only when the collateral and debt of this
   *      reserve are both >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD ($2000) and health factor > 0.95.
   * @param userAddress Address of user to liquidate
   * @param collateral Collateral reserve data
   * @param debt Debt reserve data
   * @param priceCache Pre-fetched price map for calculation
   * @param userHealthFactorRaw Raw 1e18 health factor of the target user
   * @param resolveRoute Whether to resolve the Uniswap swap route immediately
   * @param totalDebtBase User's total position debt in base currency (8 decimals), used for the 50% close factor cap
   * @return Complete liquidation parameters or null if invalid
   */
  async prepareLiquidationParams(
    userAddress: string,
    collateral: UserReserveData,
    debt: UserReserveData,
    priceCache: Map<string, number>,
    userHealthFactorRaw: bigint | number = HF_RAW.ONE,
    resolveRoute: boolean = false,
    totalDebtBase: bigint = 0n
  ): Promise<LiquidationParams | null> {
    const collateralPrice = priceCache.get(collateral.asset);
    const debtPrice = priceCache.get(debt.asset);
    if (!collateralPrice || !debtPrice) {
      logger.error('Cannot get prices for liquidation calculation');
      return null;
    }

    // Accept a decimal HF for convenience (tests / callers) but always compare as bigint.
    const hfRaw = typeof userHealthFactorRaw === 'bigint'
      ? userHealthFactorRaw
      : BigInt(Math.round(userHealthFactorRaw * 1e18));

    const collateralPriceBase = this.priceToBase(collateralPrice);
    const debtPriceBase = this.priceToBase(debtPrice);
    const collateralUnit = 10n ** BigInt(collateral.decimals);
    const debtUnit = 10n ** BigInt(debt.decimals);
    // Derive bps from the decimal fields when the raw values are not supplied.
    const bonusBps = BigInt(
      collateral.liquidationBonusBps ?? Math.round((1 + collateral.liquidationBonus / 100) * 10000)
    );
    const protocolFeeBps = BigInt(
      collateral.liquidationProtocolFeeBps ?? Math.round(collateral.liquidationProtocolFee * 100)
    );
    if (bonusBps <= 10000n) {
      logger.warn(`Invalid liquidation bonus for ${collateral.symbol} (${bonusBps} bps), skipping`);
      return null;
    }

    // --- Base-currency (8 decimals) values, exactly as Aave computes them ---
    const collateralReserveBase = (collateral.collateralBalance * collateralPriceBase) / collateralUnit;
    const debtReserveBase = (debt.debtBalance * debtPriceBase) / debtUnit;

    // --- Close factor (LiquidationLogic.executeLiquidationCall, v3.4) ---
    // Aave only caps at 50% when BOTH this reserve's collateral and debt are at least
    // MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD and the HF is strictly above CLOSE_FACTOR_HF_THRESHOLD.
    let maxProtocolDebt = debt.debtBalance;
    const closeFactorCapApplies =
      collateralReserveBase >= this.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
      debtReserveBase >= this.MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
      hfRaw > AAVE.CLOSE_FACTOR_HF_THRESHOLD_RAW;

    if (closeFactorCapApplies) {
      const totalDebtBaseBN = totalDebtBase > 0n ? totalDebtBase : debtReserveBase;
      // percentMul rounds half-up on-chain.
      const defaultLiquidatableBase = percentMul(totalDebtBaseBN, 5000n);
      if (debtReserveBase > defaultLiquidatableBase) {
        maxProtocolDebt = (defaultLiquidatableBase * debtUnit) / debtPriceBase;
      }
    }

    // --- Requested debt ---
    // Aave does NOT clamp `debtToCover` to what the collateral can back. It only clamps to the
    // close factor, then `_calculateAvailableCollateralToLiquidate` caps the SEIZED COLLATERAL at
    // the user's balance and reduces the repaid debt accordingly. Adding a collateral-side clamp
    // here made the bot under-liquidate (e.g. asking $1524 instead of $5000 on a position where
    // Aave would happily repay $2476 and seize everything).
    let debtToCover = maxProtocolDebt;
    if (debtToCover === 0n) {
      logger.warn('Calculated debtToCover is 0, skipping liquidation');
      return null;
    }

    // --- _calculateAvailableCollateralToLiquidate (exact port, half-up rounding) ---
    const computeSeize = (debtAmount: bigint) => {
      const baseCollateral = (debtPriceBase * debtAmount * collateralUnit) / (collateralPriceBase * debtUnit);
      const maxCollateralToLiquidate = percentMul(baseCollateral, bonusBps);
      let collateralAmount: bigint;
      let debtAmountNeeded: bigint;
      if (maxCollateralToLiquidate > collateral.collateralBalance) {
        collateralAmount = collateral.collateralBalance;
        debtAmountNeeded = percentDiv(
          (collateralPriceBase * collateralAmount * debtUnit) / (debtPriceBase * collateralUnit),
          bonusBps
        );
      } else {
        collateralAmount = maxCollateralToLiquidate;
        debtAmountNeeded = debtAmount;
      }
      const bonusCollateral = collateralAmount - percentDiv(collateralAmount, bonusBps);
      const protocolFee = percentMul(bonusCollateral, protocolFeeBps);
      const collateralAmountNet = collateralAmount - protocolFee;
      return { collateralAmount, collateralAmountNet, debtAmountNeeded, protocolFee };
    };

    let seize = computeSeize(debtToCover);

    /**
     * @notice Reproduces Aave's `MustNotLeaveDust` guard exactly.
     * @dev Two details matter, and both were previously wrong:
     *      1. The guard only runs when NEITHER the debt NOR the collateral is fully cleared.
     *         Aave compares `actualCollateralToLiquidate + liquidationProtocolFeeAmount` against
     *         the balance. `actualCollateralToLiquidate` is already NET of the fee, so that sum
     *         is the GROSS collateral — which is exactly `seize.collateralAmount` here. Adding
     *         `protocolFee` on top of it would double-count the fee.
     *      2. The leftovers are compared with `>=`, so a value exactly at the floor is accepted.
     */
    const violatesDustGuard = (s: {
      collateralAmount: bigint;
      collateralAmountNet: bigint;
      debtAmountNeeded: bigint;
      protocolFee: bigint;
    }): boolean => {
      const debtNotFullyCleared = s.debtAmountNeeded < debt.debtBalance;
      const collateralNotFullyCleared = s.collateralAmount < collateral.collateralBalance;
      if (!debtNotFullyCleared || !collateralNotFullyCleared) return false;

      const debtLeftoverBase = ((debt.debtBalance - s.debtAmountNeeded) * debtPriceBase) / debtUnit;
      const collateralLeftoverBase =
        ((collateral.collateralBalance - s.collateralAmount) * collateralPriceBase) / collateralUnit;
      return debtLeftoverBase < this.MIN_LEFTOVER_BASE || collateralLeftoverBase < this.MIN_LEFTOVER_BASE;
    };

    // --- MustNotLeaveDust: shrink debtToCover until Aave's own guard accepts it ---
    if (violatesDustGuard(seize)) {
      const minLeftoverBase = this.MIN_LEFTOVER_BASE;
      // Largest debt whose GROSS collateral still leaves >= MIN_LEFTOVER_BASE behind.
      const maxBaseCollateral = percentDiv(collateralReserveBase - minLeftoverBase, bonusBps);
      const maxDebtByCollateralLeftover = (maxBaseCollateral * debtUnit) / debtPriceBase;
      const maxDebtByDebtLeftover = debt.debtBalance - (minLeftoverBase * debtUnit) / debtPriceBase;

      let adjusted = maxDebtByDebtLeftover < maxDebtByCollateralLeftover
        ? maxDebtByDebtLeftover
        : maxDebtByCollateralLeftover;
      if (adjusted > maxProtocolDebt) adjusted = maxProtocolDebt;

      // The closed-form bound uses the same rounding as Aave, but a 1-wei drift is still
      // possible. Walk down until the guard provably passes instead of trusting the bound.
      let solved = false;
      for (let i = 0; i < 64 && adjusted > 0n; i++) {
        const candidate = computeSeize(adjusted);
        if (!violatesDustGuard(candidate)) {
          debtToCover = adjusted;
          seize = candidate;
          solved = true;
          break;
        }
        adjusted = (adjusted * 999n) / 1000n;
      }

      if (!solved) {
        logger.warn('MustNotLeaveDust: cannot satisfy the $1000 leftover floor on both sides, skipping liquidation');
        return null;
      }
      logger.info(
        `Adjusted for MustNotLeaveDust (v3.4, $1000 floor): debtToCover=${formatUnits(debtToCover, debt.decimals)} ${debt.symbol}`
      );
    }

    if (debtToCover === 0n || seize.collateralAmountNet === 0n) {
      logger.warn('Adjusted debtToCover/collateral is 0 after MustNotLeaveDust check, skipping liquidation');
      return null;
    }

    // --- Value accounting (all bigint, converted to USD only for logging/ranking) ---
    const debtToCoverBase = (debtToCover * debtPriceBase) / debtUnit;
    const grossCollateralBase = (seize.collateralAmount * collateralPriceBase) / collateralUnit;
    const protocolFeeBase = (seize.protocolFee * collateralPriceBase) / collateralUnit;
    const netCollateralBase = grossCollateralBase - protocolFeeBase;

    const debtToCoverUSD = Number(debtToCoverBase) / 1e8;
    const estimatedValueUSD = Number(netCollateralBase) / 1e8;

    logger.info(
      `Liquidation calc: totalDebt=${formatUnits(debt.debtBalance, debt.decimals)}, ` +
      `maxProtocolDebt=${formatUnits(maxProtocolDebt, debt.decimals)} (HF: ${formatHF(hfRaw)}), ` +
      `repaid=${formatUnits(seize.debtAmountNeeded, debt.decimals)} ${debt.symbol}, ` +
      `seized=${formatUnits(seize.collateralAmount, collateral.decimals)} ${collateral.symbol} ` +
      `(net ${formatUnits(seize.collateralAmountNet, collateral.decimals)}), ` +
      `final=${formatUnits(debtToCover, debt.decimals)} ${debt.symbol} ($${debtToCoverUSD.toFixed(2)}), ` +
      `protocolFee=$${(Number(protocolFeeBase) / 1e8).toFixed(2)}, netValue=$${estimatedValueUSD.toFixed(2)}`
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
      estimatedCollateralAmount: seize.collateralAmountNet,
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
    const bitmapContracts = users.map(user => ({
      address: this.poolAddress as Address,
      abi: this.poolAbi,
      functionName: 'getUserConfiguration',
      args: [user.user as Address],
    }));
    const bitmapResults = await this.publicClient.multicall({ contracts: bitmapContracts, allowFailure: true });
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
      // Resolve ids through the index-aligned reserve list. A `null` entry means the reserve
      // config could not be fetched; skipping it keeps every other id correct.
      const validIds = allActiveIds.filter(id => this.assetManager.getReserveAddressById(id) !== undefined);
      if (validIds.length === 0) continue;
      userReserveMap.set(users[i].user, {
        ids: validIds,
        startIndex: currentIndex,
        count: validIds.length,
      });
      for (const reserveId of validIds) {
        const reserveAddress = this.assetManager.getReserveAddressById(reserveId)!;
        allActiveAssets.add(reserveAddress);
        reserveDataContracts.push({
          address: this.protocolDataProvider as Address,
          abi: this.dataProviderAbi,
          functionName: 'getUserReserveData',
          args: [reserveAddress as Address, users[i].user as Address],
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
      contracts: [...reserveDataContracts, priceContract],
      allowFailure: true,
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
        const reserveAddress = this.assetManager.getReserveAddressById(reserveId);
        if (!reserveAddress) continue;
        const config = this.assetManager.getAssetConfig(reserveAddress);
        if (!config) {
          logger.warn(`Config not found for reserve ${reserveId}, skipping`);
          continue;
        }
        userReserves.push({
          asset: reserveAddress,
          symbol: config.symbol,
          decimals: config.decimals,
          collateralBalance,
          debtBalance,
          usageAsCollateralEnabled,
          liquidationBonus: config.liquidationBonus,
          liquidationProtocolFee: config.liquidationProtocolFee,
          liquidationBonusBps: config.liquidationBonusBps,
          liquidationProtocolFeeBps: config.liquidationProtocolFeeBps,
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
        userHealth.healthFactorRaw,
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
