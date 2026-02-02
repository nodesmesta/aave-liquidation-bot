import { GraphQLClient, gql } from 'graphql-request';
import { createPublicClient, http, parseAbi, Address } from 'viem';
import { basePreconf } from 'viem/chains';
import { logger } from '../utils/logger';
import { config } from '../config';

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

export class SubgraphService {
  private client: GraphQLClient;
  private reservesListCache: Map<string, Address[]> = new Map();  
  private reservesDecimalsCache: Map<string, Map<string, number>> = new Map();
  private readonly STABLE_ASSETS = new Set([
    'USDC',
    'USDbC',
    'GHO',
    'EURC'
  ]);

  constructor(subgraphUrl: string, apiKey?: string) {
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
   * @dev Uses cursor-based pagination (1000 per batch), filters same-asset and stablecoin-only positions
   * @dev Filters e-Mode users at query level (server-side) for efficiency
   * @dev Threshold 1000 = $0.001 for USDC (6 decimals) or negligible for WETH (18 decimals)
   * @return Map of user address to array of debt asset addresses
   */
  async getActiveBorrowers(): Promise<Map<string, string[]>> {
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
      
      const candidateUsers = new Map<string, string[]>();
      let filteredByStablecoin = 0;
      for (const user of allUsers) {
        const userAddress = user.id.toLowerCase();
        const collateralAssets: string[] = [];
        const debtAssets: string[] = [];
        for (const reserve of user.reserves) {
          const symbol = reserve.reserve.symbol;
          const balance = parseFloat(reserve.currentATokenBalance);
          const debt = parseFloat(reserve.currentTotalDebt);
          const hasCollateral = balance > 0 && reserve.usageAsCollateralEnabledOnUser;
          const hasDebt = debt > 0;
          if (hasCollateral) collateralAssets.push(symbol);
          if (hasDebt) debtAssets.push(symbol);
        }
        
        // Filter stablecoin-only positions (low volatility, low liquidation risk)
        const allStablecoinCollateral = collateralAssets.every(a => this.STABLE_ASSETS.has(a));
        const allStablecoinDebt = debtAssets.every(a => this.STABLE_ASSETS.has(a));
        if (allStablecoinCollateral && allStablecoinDebt) {
          filteredByStablecoin++;
          continue;
        }
        
        // Include users with volatile assets (cross-asset or unhedged exposure)
        const hasUnhedgedCollateral = collateralAssets.some(c => !debtAssets.includes(c));
        const hasCrossAssetDebt = debtAssets.some(d => !collateralAssets.includes(d));
        if (hasUnhedgedCollateral || hasCrossAssetDebt) {
          candidateUsers.set(userAddress, debtAssets.map(symbol => 
            user.reserves.find(r => r.reserve.symbol === symbol)?.reserve.underlyingAsset || ''
          ).filter(addr => addr !== ''));
        }
      }
      logger.info(`Found ${candidateUsers.size} candidates (excluded e-Mode users at query level, filtered ${filteredByStablecoin} stablecoin-only)`);
      logger.info(`Returning ${candidateUsers.size} candidate users for on-chain validation`);
      return candidateUsers;
  }

  /**
   * @notice Validate users on-chain using viem multicall for batch efficiency
   * @dev Two-phase validation: HF screening → asset composition check, filters hedged positions
   * @param userAddresses Array of user addresses to validate
   * @param rpcUrl RPC endpoint URL
   * @param poolAddress Aave V3 Pool contract address
   * @param protocolDataProvider Protocol data provider address
   * @return Map of user address to health data (HF < 1.075)
   */
  async validateUsersOnChain(
    userAddresses: string[],
    rpcUrl: string,
    poolAddress: string,
    protocolDataProvider: string
  ): Promise<Map<string, { hf: number; collateral: number; debt: number; collateralAssets: string[]; debtAssets: string[] }>> {
    logger.info(`Validating ${userAddresses.length} users on-chain via viem multicall...`);
    const client = createPublicClient({
      chain: basePreconf,
      transport: http(rpcUrl),
    });
    const poolAbi = parseAbi([
      'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
      'function getUserConfiguration(address user) external view returns ((uint256 data))',
      'function getReservesList() external view returns (address[])',
    ]);

    const protocolDataProviderAbi = parseAbi([
      'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    ]);

    const results = new Map<string, { hf: number; collateral: number; debt: number; collateralAssets: string[]; debtAssets: string[] }>();
    let totalValidated = 0;
    let filteredByHF = 0;
    let filteredByHedging = 0;
    let reservesList: Address[];
    let reservesDecimals: Map<string, number>;
    const cacheKey = `${poolAddress}`;
    if (this.reservesListCache.has(cacheKey) && this.reservesDecimalsCache.has(cacheKey)) {
      reservesList = this.reservesListCache.get(cacheKey)!;
      reservesDecimals = this.reservesDecimalsCache.get(cacheKey)!;
    } else {
      reservesList = await client.readContract({
        address: poolAddress as Address,
        abi: poolAbi,
        functionName: 'getReservesList',
      }) as Address[];
      const decimalsAbi = parseAbi([
        'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
      ]);
      const decimalsCalls = reservesList.map(reserve => ({
        address: protocolDataProvider as Address,
        abi: decimalsAbi,
        functionName: 'getReserveConfigurationData',
        args: [reserve],
      }));
      const decimalsResults = await client.multicall({
        contracts: decimalsCalls,
      });
      reservesDecimals = new Map();
      for (let i = 0; i < reservesList.length; i++) {
        if (decimalsResults[i].status === 'success' && decimalsResults[i].result) {
          const [decimals] = decimalsResults[i].result as readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean];
          reservesDecimals.set(reservesList[i].toLowerCase(), Number(decimals));
        }
      }
      this.reservesListCache.set(cacheKey, reservesList);
      this.reservesDecimalsCache.set(cacheKey, reservesDecimals);
    }

    try {
      const BATCH_SIZE = config.rateLimit.batchSize;
      const BATCH_DELAY_MS = config.rateLimit.batchDelayMs;
      const atRiskUsers: Array<{ address: string; hf: number; collateral: number; debt: number }> = [];
      const totalBatches = Math.ceil(userAddresses.length / BATCH_SIZE);
      
      logger.info(`Processing ${userAddresses.length} users in ${totalBatches} batches (size: ${BATCH_SIZE}, delay: ${BATCH_DELAY_MS}ms)`);
      
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const start = batchIndex * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, userAddresses.length);
        const batchAddresses = userAddresses.slice(start, end);
        
        // Rate limiting: delay between batches
        if (batchIndex > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
        
        // Progress logging every 10 batches
        if (batchIndex % 10 === 0) {
          logger.info(`Processing batch ${batchIndex + 1}/${totalBatches} (${Math.round((batchIndex / totalBatches) * 100)}%)`);
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
          });
        } catch (error: any) {
          // Handle rate limit errors with exponential backoff
          if (error.code === 429 || error.message?.includes('compute units')) {
            const backoffMs = Math.min(BATCH_DELAY_MS * Math.pow(2, batchIndex % 5), 5000);
            logger.warn(`Rate limit hit at batch ${batchIndex + 1}, backing off ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            // Retry once
            accountDataResults = await client.multicall({
              contracts: accountDataCalls,
            });
          } else {
            throw error;
          }
        }
        
        for (let i = 0; i < batchAddresses.length; i++) {
          const accountDataResult = accountDataResults[i];
          if (accountDataResult.status === 'success' && accountDataResult.result) {
            const result = accountDataResult.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
            const [totalCollateralBase, totalDebtBase, , , , healthFactor] = result;
            const totalCollateralUSD = Number(totalCollateralBase) / 1e8;
            const totalDebtUSD = Number(totalDebtBase) / 1e8;
            const hf = Number(healthFactor) / 1e18;
            totalValidated++;
            if (hf < 1.075 && totalDebtUSD >= 100) {
              atRiskUsers.push({
                address: batchAddresses[i],
                hf,
                collateral: totalCollateralUSD,
                debt: totalDebtUSD,
              });
            } else {
              filteredByHF++;
            }
          }
        }
      }
      
      logger.info(`Phase 1 complete: ${atRiskUsers.length} users with HF < 1.075 (filtered ${filteredByHF} healthy users)`);
      
      const atRiskBatches = Math.ceil(atRiskUsers.length / BATCH_SIZE);
      logger.info(`Processing ${atRiskUsers.length} at-risk users in ${atRiskBatches} batches for asset validation...`);
      
      for (let batchIndex = 0; batchIndex < atRiskBatches; batchIndex++) {
        const start = batchIndex * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, atRiskUsers.length);
        const batchUsers = atRiskUsers.slice(start, end);
        
        // Rate limiting: delay between batches
        if (batchIndex > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
        
        // Progress logging every 5 batches
        if (batchIndex % 5 === 0) {
          logger.info(`Asset validation batch ${batchIndex + 1}/${atRiskBatches} (${Math.round((batchIndex / atRiskBatches) * 100)}%)`);
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
          });
        } catch (error: any) {
          // Handle rate limit errors with exponential backoff
          if (error.code === 429 || error.message?.includes('compute units')) {
            const backoffMs = Math.min(BATCH_DELAY_MS * Math.pow(2, batchIndex % 5), 5000);
            logger.warn(`Rate limit hit at asset validation batch ${batchIndex + 1}, backing off ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            // Retry once
            userConfigResults = await client.multicall({
              contracts: userConfigCalls,
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
                  });
                  for (let k = 0; k < reserveDataResults.length; k++) {
                    const reserveResult = reserveDataResults[k];
                    if (reserveResult.status === 'success' && reserveResult.result) {
                      const [currentATokenBalance, , currentVariableDebt, , , , , , usageAsCollateralEnabled] = reserveResult.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
                      const reserveIndex = reserveIndices[k];
                      const reserveAddress = reservesList[reserveIndex].toLowerCase();
                      const decimals = reservesDecimals.get(reserveAddress) || 18;
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
          const hasUnhedgedExposure = collateralAssets.some(c => !debtAssets.includes(c)) ||
            debtAssets.some(d => !collateralAssets.includes(d));
          let shouldInclude = false;
          if (user.hf < 1.075) {
            shouldInclude = true;
          }
          if (shouldInclude) {
            results.set(user.address.toLowerCase(), {
              hf: user.hf,
              collateral: user.collateral,
              debt: user.debt,
              collateralAssets,
              debtAssets,
            });
          } else {
            filteredByHF++;
          }
        }
      }
      logger.info(`Successfully validated ${totalValidated}/${userAddresses.length} users on-chain`);
      logger.info(`Critical risk users (HF < 1.075): ${results.size} | Filtered by HF/size: ${filteredByHF} | Filtered by hedging: ${filteredByHedging}`);
      return results;
    } catch (error) {
      logger.error('Error during multicall validation:', error);
      throw error;
    }
  }
}