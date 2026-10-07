import { parseAbi, Address, encodePacked, PublicClient } from 'viem';
import { logger } from '../utils/logger';
import { AssetManager } from './AssetManager';

export interface RouteQuote {
  path: `0x${string}`;
  amountOut: bigint;
  hops: number;
  gasEstimate: bigint;
  description: string;
}

export interface CachedRoute {
  quote: RouteQuote;
  timestamp: number;
}

export class SmartRouter {
  // Uniswap V3 canonical fee tiers: 0.01%, 0.05%, 0.3%, 1%
  public static readonly DIRECT_FEE_TIERS = [100, 500, 3000, 10000];
  // Common fee tiers for multi-hop routes
  public static readonly MULTIHOP_FEE_TIERS = [100, 500, 3000];

  private readonly quoterAbi = parseAbi([
    'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  ]);

  private publicClient: PublicClient;
  private quoterAddress: Address;
  private assetManager: AssetManager;
  private cache: Map<string, CachedRoute> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(publicClient: any, quoterAddress: Address, assetManager: AssetManager) {
    this.publicClient = publicClient;
    this.quoterAddress = quoterAddress;
    this.assetManager = assetManager;
  }

  /**
   * Helper to encode 1-hop Uniswap V3 path
   */
  public static encodeDirectPath(tokenIn: Address, fee: number, tokenOut: Address): `0x${string}` {
    return encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
  }

  /**
   * Helper to encode 2-hop Uniswap V3 path
   */
  public static encodeTwoHopPath(
    tokenIn: Address,
    fee1: number,
    hub: Address,
    fee2: number,
    tokenOut: Address
  ): `0x${string}` {
    return encodePacked(
      ['address', 'uint24', 'address', 'uint24', 'address'],
      [tokenIn, fee1, hub, fee2, tokenOut]
    );
  }

  private getCacheKey(tokenIn: string, tokenOut: string): string {
    return `${tokenIn.toLowerCase()}_${tokenOut.toLowerCase()}`;
  }

  /**
   * @notice Get best route with sub-millisecond in-memory cache lookup
   * @dev Returns cached route immediately if valid (<5 min). Falls back to full quote search.
   */
  async getBestRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    forceRefresh: boolean = false
  ): Promise<RouteQuote | null> {
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      return {
        path: '0x' as `0x${string}`,
        amountOut: amountIn,
        hops: 0,
        gasEstimate: 0n,
        description: 'Direct (same token)',
      };
    }

    const key = this.getCacheKey(tokenIn, tokenOut);
    const cached = this.cache.get(key);
    const now = Date.now();

    if (!forceRefresh && cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.quote;
    }

    // Evaluate all candidate paths
    const bestQuote = await this.findBestRouteOnChain(tokenIn as Address, tokenOut as Address, amountIn);

    if (bestQuote) {
      this.cache.set(key, {
        quote: bestQuote,
        timestamp: now,
      });
    }

    return bestQuote;
  }

  /**
   * @notice Evaluate all candidate paths (direct and 2-hop via hubs) using QuoterV2
   */
  async findBestRouteOnChain(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<RouteQuote | null> {
    const candidatePaths: Array<{ path: `0x${string}`; hops: number; desc: string }> = [];

    // 1. Direct paths (all 4 fee tiers)
    for (const fee of SmartRouter.DIRECT_FEE_TIERS) {
      candidatePaths.push({
        path: SmartRouter.encodeDirectPath(tokenIn, fee, tokenOut),
        hops: 1,
        desc: `Direct fee:${fee}`,
      });
    }

    // 2. Multi-hop paths (via dynamic hubs from AssetManager)
    const hubs = this.assetManager.getRoutingHubs();
    for (const hub of hubs) {
      if (hub.toLowerCase() === tokenIn.toLowerCase() || hub.toLowerCase() === tokenOut.toLowerCase()) {
        continue;
      }

      for (const fee1 of SmartRouter.MULTIHOP_FEE_TIERS) {
        for (const fee2 of SmartRouter.MULTIHOP_FEE_TIERS) {
          candidatePaths.push({
            path: SmartRouter.encodeTwoHopPath(tokenIn, fee1, hub, fee2, tokenOut),
            hops: 2,
            desc: `2-hop via ${hub.slice(0, 6)} (fees: ${fee1}/${fee2})`,
          });
        }
      }
    }

    // Quote all candidate paths concurrently
    const quotePromises = candidatePaths.map(async (candidate) => {
      try {
        const result = await this.publicClient.readContract({
          address: this.quoterAddress,
          abi: this.quoterAbi,
          functionName: 'quoteExactInput',
          args: [candidate.path, amountIn],
        });

        const [amountOut, , , gasEstimate] = result as [bigint, readonly bigint[], readonly number[], bigint];
        if (amountOut > 0n) {
          return {
            path: candidate.path,
            amountOut,
            hops: candidate.hops,
            gasEstimate,
            description: candidate.desc,
          } as RouteQuote;
        }
      } catch {
        // Pool does not exist or has insufficient liquidity; expected for invalid routes
      }
      return null;
    });

    const results = await Promise.all(quotePromises);
    const validQuotes = results.filter((q): q is RouteQuote => q !== null);

    if (validQuotes.length === 0) {
      logger.warn(`No valid Uniswap V3 route found for ${tokenIn} -> ${tokenOut}`);
      return null;
    }

    // Select the route with the highest amountOut
    validQuotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
    const best = validQuotes[0];

    logger.info(
      `SmartRouter best route: ${best.description} -> amountOut: ${best.amountOut.toString()} (evaluated ${validQuotes.length} active routes)`
    );

    return best;
  }

  /**
   * @notice Pre-warm route cache for a list of token pairs
   */
  async prewarmRoutes(
    pairs: Array<{ tokenIn: string; tokenOut: string; sampleAmountIn: bigint }>
  ): Promise<void> {
    logger.info(`SmartRouter: Pre-warming route cache for ${pairs.length} pairs...`);
    const start = Date.now();
    await Promise.allSettled(
      pairs.map((p) => this.getBestRoute(p.tokenIn, p.tokenOut, p.sampleAmountIn, true))
    );
    logger.info(`SmartRouter: Pre-warming complete in ${Date.now() - start}ms (cached: ${this.cache.size} routes)`);
  }

  /**
   * @notice Start background cache refresh
   */
  startPeriodicRefresh(
    getPairsFn: () => Array<{ tokenIn: string; tokenOut: string; sampleAmountIn: bigint }>,
    intervalMs: number = 5 * 60 * 1000
  ): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    this.refreshInterval = setInterval(async () => {
      try {
        const pairs = getPairsFn();
        if (pairs.length > 0) {
          await this.prewarmRoutes(pairs);
        }
      } catch (err: any) {
        logger.error(`SmartRouter periodic refresh error: ${err.message}`);
      }
    }, intervalMs);
  }

  stopPeriodicRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
