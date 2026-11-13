import { GraphQLClient, gql } from 'graphql-request';
import { parseAbi, Address } from 'viem';
import { logger } from '../utils/logger';
import { config } from '../config';
import { AAVE, HF, HF_RAW, hfRawToNumber, isPoolTierRaw, shouldPruneRaw } from '../config/thresholds';
import { AssetManager } from './AssetManager';

interface UserReserve {
  reserve: {
    underlyingAsset: string;
    symbol: string;
    decimals: number;
    baseLTVasCollateral: string;
    reserveLiquidationThreshold: string;
    reserveLiquidationBonus: string;
    price: {
      priceInEth: string;
    };
  };
  currentATokenBalance: string;
  currentTotalDebt: string;
  usageAsCollateralEnabledOnUser: boolean;
}

interface User {
  id: string;
  borrowedReservesCount: number;
  reserves: UserReserve[];
}

export interface CandidateAssets {
  collateralAssets: string[];
  debtAssets: string[];
  /** Per-asset USD value of collateral (lowercase asset -> USD). */
  collateralUSDByAsset: Record<string, number>;
  /** Per-asset USD value of debt (lowercase asset -> USD). */
  debtUSDByAsset: Record<string, number>;
}

export interface ValidatedUser {
  hf: number;
  /** Raw 1e18 health factor from the on-chain call. */
  hfRaw: bigint;
  collateral: number;
  debt: number;
  collateralAssets: string[];
  debtAssets: string[];
  collateralUSDByAsset: Record<string, number>;
  debtUSDByAsset: Record<string, number>;
  /** Average liquidation threshold in bps (e.g. 8250 = 82.5%), from getUserAccountData. */
  liquidationThresholdBps: bigint;
}

export class SubgraphService {
  private client: GraphQLClient;
  private assetManager: AssetManager;
  private publicClient: any;

  constructor(subgraphUrl: string, publicClient: any, assetManager: AssetManager, apiKey?: string) {
    this.publicClient = publicClient;
    this.assetManager = assetManager;
    const key = apiKey || process.env.SUBGRAPH_API_KEY || '';
    this.client = new GraphQLClient(subgraphUrl, {
      headers: {
        'Content-Type': 'application/json',
        ...(key && { 'Authorization': `Bearer ${key}` }),
      },
    });
  }

  /**
   * @notice Get active borrowers from Aave V3 Subgraph (all debt assets, minimal filter)
   * @dev Uses cursor-based pagination (1000 per batch), filters e-Mode users at query level
   * @dev Collateral composition is captured here (usageAsCollateralEnabledOnUser + balance > 0) so
   *      WATCH-tier users can be triggered by price moves without any extra RPC.
   * @return Map of user address to collateral/debt asset addresses
   */
  async getActiveBorrowers(): Promise<Map<string, CandidateAssets>> {
    logger.info('Querying debt borrowers from Subgraph (excluding e-Mode users)...');
    const allUsers: User[] = [];
    let lastId = '';
    let batchNumber = 0;
    let hasMore = true;
    while (hasMore) {
      batchNumber++;
      const whereClause = lastId 
        ? `borrowedReservesCount_gt: 0, id_gt: "${lastId}", eModeCategoryId: null`
        : `borrowedReservesCount_gt: 0, eModeCategoryId: null`;

      const query = gql`
        query GetNonEModeDebtBorrowers {
          users(
            first: 1000
            where: {
              ${whereClause}
            }
            orderBy: id
            orderDirection: asc
          ) {
            id
            reserves {
              currentATokenBalance
              currentTotalDebt
              usageAsCollateralEnabledOnUser
              reserve {
                symbol
                underlyingAsset
                decimals
                reserveLiquidationThreshold
                price {
                  priceInEth
                }
              }
            }
          }
        }
      `;

      try {
        const data = await this.client.request<{ users: User[] }>(query);
        const users = data.users || [];
        if (users.length > 0) {
          allUsers.push(...users);
          lastId = users[users.length - 1].id;
        }
        if (users.length < 1000) {
          hasMore = false;
        }
        if (batchNumber >= 100) {
          logger.warn(`Reached safety limit (100 batches), stopping pagination`);
          hasMore = false;
        }
      } catch (error) {
        logger.error(`Error querying batch ${batchNumber}:`, error);
        throw error;
      }
    }

    if (allUsers.length === 0) {
      logger.warn('No debt users returned from subgraph');
      return new Map();
    }
    logger.info(`Total found: ${allUsers.length} users with debt`);
      
      const candidateUsers = new Map<string, CandidateAssets>();
      let filteredHealthy = 0;
      for (const user of allUsers) {
        const userAddress = user.id.toLowerCase();
        let totalDebtBase = 0;
        let totalThresholdBase = 0;
        const debtAssets: string[] = [];
        const collateralAssets: string[] = [];
        const collateralUSDByAsset: Record<string, number> = {};
        const debtUSDByAsset: Record<string, number> = {};

        for (const reserve of user.reserves) {
          const priceInEth = parseFloat(reserve.reserve.price?.priceInEth || '0');
          const decimals = reserve.reserve.decimals || 18;
          const hasCollateral = reserve.usageAsCollateralEnabledOnUser && parseFloat(reserve.currentATokenBalance) > 0;
          const hasDebt = parseFloat(reserve.currentTotalDebt) > 0;
          const assetAddress = reserve.reserve.underlyingAsset.toLowerCase();

          if (hasCollateral) {
            const balance = parseFloat(reserve.currentATokenBalance) / (10 ** decimals);
            const collateralBase = balance * priceInEth;
            const liqThreshold = parseFloat(reserve.reserve.reserveLiquidationThreshold || '0');
            totalThresholdBase += collateralBase * (liqThreshold / 10000);
            collateralAssets.push(assetAddress);
            collateralUSDByAsset[assetAddress] = (collateralUSDByAsset[assetAddress] ?? 0) + collateralBase;
          }

          if (hasDebt) {
            const debt = parseFloat(reserve.currentTotalDebt) / (10 ** decimals);
            const debtBase = debt * priceInEth;
            totalDebtBase += debtBase;
            debtAssets.push(assetAddress);
            debtUSDByAsset[assetAddress] = (debtUSDByAsset[assetAddress] ?? 0) + debtBase;
          }
        }

        const estimatedHF = totalDebtBase === 0 ? Infinity : totalThresholdBase / totalDebtBase;

        // Pre-filter uses a wide buffer: subgraph `priceInEth` lags the on-chain oracle, so a fast
        // crash can make an on-chain-HF-0.98 user look like 1.20 here. Anything above the buffer is
        // dropped; everything else is validated on-chain.
        if (estimatedHF <= HF.SUBGRAPH_PREFILTER) {
          candidateUsers.set(userAddress, {
            collateralAssets,
            debtAssets,
            collateralUSDByAsset,
            debtUSDByAsset,
          });
        } else {
          filteredHealthy++;
        }
      }
      logger.info(`Found ${candidateUsers.size} candidates (excluded e-Mode users at query level, filtered ${filteredHealthy} healthy users with Est. HF > ${HF.SUBGRAPH_PREFILTER})`);
      logger.info(`Returning ${candidateUsers.size} candidate users for on-chain validation`);
      return candidateUsers;
  }

  /**
   * @notice Validate users on-chain using viem multicall for batch efficiency
   * @dev Two-phase validation: HF screening → asset composition check, filters hedged positions.
   *      Returns two buckets: atRisk (HF < 1.075, asset composition verified on-chain) and
   *      watched (1.075 <= HF <= 1.15, asset composition taken from the subgraph candidate list).
   * @param candidates Map of user address to subgraph-derived collateral/debt assets
   * @param poolAddress Aave V3 Pool contract address
   * @param protocolDataProvider Protocol data provider address
   * @return atRisk (HF < 1.075) and watched (1.075 <= HF <= 1.15) user maps
   */
  async validateUsersOnChain(
    candidates: Map<string, CandidateAssets>,
    poolAddress: string,
    protocolDataProvider: string
  ): Promise<{ atRisk: Map<string, ValidatedUser>; watched: Map<string, ValidatedUser> }> {
    const userAddresses = Array.from(candidates.keys());
    logger.info(`Validating ${userAddresses.length} users on-chain via viem multicall...`);
    const client = this.publicClient;
    const poolAbi = parseAbi([
      'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
      'function getUserConfiguration(address user) external view returns ((uint256 data))',
      'function getReservesList() external view returns (address[])',
    ]);

    const protocolDataProviderAbi = parseAbi([
      'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    ]);

    const atRiskResults = new Map<string, ValidatedUser>();
    const watchedResults = new Map<string, ValidatedUser>();
    let totalValidated = 0;
    let filteredByHF = 0;
    let filteredByHedging = 0;
    const allReserves = this.assetManager.getAllReserves();
    const reservesList = allReserves.map(r => r.address as Address);

    try {
      const BATCH_SIZE = config.rateLimit.batchSize;
      const BATCH_DELAY_MS = config.rateLimit.batchDelayMs;
      const atRiskUsers: Array<{ address: string; hf: number; hfRaw: bigint; collateral: number; debt: number; liquidationThresholdBps: bigint }> = [];
      const totalBatches = Math.ceil(userAddresses.length / BATCH_SIZE);
      
      logger.info(`Validating ${userAddresses.length} users on-chain via multicall (${totalBatches} batches)...`);
      
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const start = batchIndex * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, userAddresses.length);
        const batchAddresses = userAddresses.slice(start, end);
        if (batchIndex > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
        
        const accountDataCalls = batchAddresses.map(address => ({
          address: poolAddress as Address,
          abi: poolAbi,
          functionName: 'getUserAccountData',
          args: [address as Address],
        }));
        
        let accountDataResults;
        try {
          accountDataResults = await client.multicall({
            contracts: accountDataCalls,
            allowFailure: true,
          });
        } catch (error: any) {
          if (error.code === 429 || error.message?.includes('compute units')) {
            const backoffMs = Math.min(BATCH_DELAY_MS * Math.pow(2, batchIndex % 5), 5000);
            logger.warn(`Rate limit hit at batch ${batchIndex + 1}, backing off ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            accountDataResults = await client.multicall({
              contracts: accountDataCalls,
              allowFailure: true,
            });
          } else {
            throw error;
          }
        }
        
        for (let i = 0; i < batchAddresses.length; i++) {
          const accountDataResult = accountDataResults[i];
          if (accountDataResult.status === 'success' && accountDataResult.result) {
            const result = accountDataResult.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
            const [totalCollateralBase, totalDebtBase, , currentLiquidationThreshold, , healthFactorRaw] = result;
            const totalCollateralUSD = Number(totalCollateralBase) / 1e8;
            const totalDebtUSD = Number(totalDebtBase) / 1e8;
            const hf = hfRawToNumber(healthFactorRaw);
            totalValidated++;
            const userAddr = batchAddresses[i].toLowerCase();
            if (isPoolTierRaw(healthFactorRaw) && totalDebtUSD >= AAVE.MIN_TRACKED_DEBT_USD) {
              atRiskUsers.push({
                address: batchAddresses[i],
                hf,
                hfRaw: healthFactorRaw,
                collateral: totalCollateralUSD,
                debt: totalDebtUSD,
                liquidationThresholdBps: currentLiquidationThreshold,
              });
            } else if (!shouldPruneRaw(healthFactorRaw) && totalDebtUSD >= AAVE.MIN_TRACKED_DEBT_USD) {
              // WATCH tier: keep tracking so a price move re-evaluates it, using subgraph asset composition
              const assets = candidates.get(userAddr);
              watchedResults.set(userAddr, {
                hf,
                hfRaw: healthFactorRaw,
                collateral: totalCollateralUSD,
                debt: totalDebtUSD,
                collateralAssets: assets?.collateralAssets ?? [],
                debtAssets: assets?.debtAssets ?? [],
                collateralUSDByAsset: assets?.collateralUSDByAsset ?? {},
                debtUSDByAsset: assets?.debtUSDByAsset ?? {},
                liquidationThresholdBps: currentLiquidationThreshold,
              });
              filteredByHF++;
            } else {
              filteredByHF++;
            }
          }
        }
      }
      
      logger.info(`Phase 1 complete: ${atRiskUsers.length} users with HF < ${HF.POOL_TIER}, ${watchedResults.size} watched (${HF.POOL_TIER} <= HF < ${HF.WATCH_MAX}), filtered ${filteredByHF} healthy users`);
      
      const atRiskBatches = Math.ceil(atRiskUsers.length / BATCH_SIZE);
      logger.info(`Validating assets for ${atRiskUsers.length} at-risk users (${atRiskBatches} batches)...`);
      
      for (let batchIndex = 0; batchIndex < atRiskBatches; batchIndex++) {
        const start = batchIndex * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, atRiskUsers.length);
        const batchUsers = atRiskUsers.slice(start, end);
        if (batchIndex > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
        
        const userConfigCalls = batchUsers.map(user => ({
          address: poolAddress as Address,
          abi: poolAbi,
          functionName: 'getUserConfiguration',
          args: [user.address as Address],
        }));
        
        let userConfigResults;
        try {
          userConfigResults = await client.multicall({
            contracts: userConfigCalls,
            allowFailure: true,
          });
        } catch (error: any) {
          if (error.code === 429 || error.message?.includes('compute units')) {
            const backoffMs = Math.min(BATCH_DELAY_MS * Math.pow(2, batchIndex % 5), 5000);
            logger.warn(`Rate limit hit at asset validation batch ${batchIndex + 1}, backing off ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            userConfigResults = await client.multicall({
              contracts: userConfigCalls,
              allowFailure: true,
            });
          } else {
            throw error;
          }
        }
        
        for (let i = 0; i < batchUsers.length; i++) {
          const user = batchUsers[i];
          const userConfigResult = userConfigResults[i];
          const collateralAssets: string[] = [];
          const debtAssets: string[] = [];
          if (userConfigResult.status === 'success' && userConfigResult.result) {
            try {
              const resultData = userConfigResult.result as any;
              let configData: bigint | undefined;
              if (typeof resultData === 'object' && resultData !== null) {
                configData = resultData.data || resultData[0];
              } else if (Array.isArray(resultData) && resultData.length > 0) {
                configData = resultData[0];
              }
              if (configData !== undefined && configData !== null) {
                const bitmap = typeof configData === 'bigint' ? configData : BigInt(configData);
                const reserveDataCalls: any[] = [];
                const reserveIndices: number[] = [];
                for (let j = 0; j < reservesList.length; j++) {
                  const isBorrowing = (bitmap & (1n << BigInt(j * 2))) !== 0n;
                  const isCollateral = (bitmap & (1n << BigInt(j * 2 + 1))) !== 0n;
                  if (isCollateral || isBorrowing) {
                    reserveDataCalls.push({
                      address: protocolDataProvider as Address,
                      abi: protocolDataProviderAbi,
                      functionName: 'getUserReserveData',
                      args: [reservesList[j], user.address as Address],
                    });
                    reserveIndices.push(j);
                  }
                }
                if (reserveDataCalls.length > 0) {
                  const reserveDataResults = await client.multicall({
                    contracts: reserveDataCalls,
                    allowFailure: true,
                  });
                  for (let k = 0; k < reserveDataResults.length; k++) {
                    const reserveResult = reserveDataResults[k];
                    if (reserveResult.status === 'success' && reserveResult.result) {
                      const [currentATokenBalance, , currentVariableDebt, , , , , , usageAsCollateralEnabled] = reserveResult.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
                      const reserveIndex = reserveIndices[k];
                      const reserveAddress = reservesList[reserveIndex].toLowerCase();
                      const config = this.assetManager.getAssetConfig(reserveAddress);
                      const decimals = config?.decimals || 18;
                      const collateralAmount = Number(currentATokenBalance) / (10 ** decimals);
                      const debtAmount = Number(currentVariableDebt) / (10 ** decimals);
                      const hasSignificantCollateral = collateralAmount > 0.01 && usageAsCollateralEnabled;
                      const hasSignificantDebt = debtAmount > 0.01;
                      if (hasSignificantCollateral) {
                        collateralAssets.push(reserveAddress);
                      }
                      if (hasSignificantDebt) {
                        debtAssets.push(reserveAddress);
                      }
                    }
                  }
                }
              }
            } catch (bitmapError) {
            }
          }
          if (collateralAssets.length === 0 && debtAssets.length === 0) {
            filteredByHF++;
            continue;
          }
          const hedgedAssetAddresses = collateralAssets.filter(c => debtAssets.includes(c));
          const isFullyHedged = hedgedAssetAddresses.length > 0 && 
            hedgedAssetAddresses.length === collateralAssets.length && 
            hedgedAssetAddresses.length === debtAssets.length;
          if (isFullyHedged) {
            filteredByHedging++;
            continue;
          }
          if (isPoolTierRaw(user.hfRaw)) {
            // Per-asset USD breakdown comes from the subgraph candidate list. It is only used for
            // local HF estimation between on-chain reads, so subgraph-level precision is enough.
            const subgraphAssets = candidates.get(user.address.toLowerCase());
            atRiskResults.set(user.address.toLowerCase(), {
              hf: user.hf,
              hfRaw: user.hfRaw,
              collateral: user.collateral,
              debt: user.debt,
              collateralAssets,
              debtAssets,
              collateralUSDByAsset: subgraphAssets?.collateralUSDByAsset ?? {},
              debtUSDByAsset: subgraphAssets?.debtUSDByAsset ?? {},
              liquidationThresholdBps: user.liquidationThresholdBps,
            });
          } else {
            filteredByHF++;
          }
        }
      }
      logger.info(`Successfully validated ${totalValidated}/${userAddresses.length} users on-chain`);
      logger.info(`Critical risk users (HF < ${HF.POOL_TIER}): ${atRiskResults.size} | Watched (${HF.POOL_TIER}-${HF.WATCH_MAX}): ${watchedResults.size} | Filtered by HF/size: ${filteredByHF} | Filtered by hedging: ${filteredByHedging}`);
      return { atRisk: atRiskResults, watched: watchedResults };
    } catch (error) {
      logger.error('Error during multicall validation:', error);
      throw error;
    }
  }
}