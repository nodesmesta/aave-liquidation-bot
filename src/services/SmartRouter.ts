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
  private assetManager?: AssetManager;
  private cache: Map<string, CachedRoute> = new Map();
  private readonly CACHE_TTL_MS = 15 * 1000; // 15 seconds for short-lived on-demand deduplication

  constructor(
    publicClient: any,
    quoterAddress: Address = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    assetManager?: AssetManager
  ) {
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

  private getCacheKey(tokenIn: string, tokenOut: string, amountIn: bigint): string {
    return `${tokenIn.toLowerCase()}_${tokenOut.toLowerCase()}_${amountIn.toString()}`;
  }

  /**
   * @notice Get best route with sub-millisecond in-memory cache lookup
   * @dev Returns cached route immediately if valid (<15s) with matching amountIn. Falls back to on-chain quote.
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

    const key = this.getCacheKey(tokenIn, tokenOut, amountIn);
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

    // 2. Multi-hop paths (via dynamic hubs from AssetManager if available)
    const hubs = this.assetManager ? this.assetManager.getRoutingHubs() : [];
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

    if (candidatePaths.length === 0) {
      return null;
    }

    // Quote candidate paths using Multicall3 with allowFailure: true
    const validQuotes: RouteQuote[] = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < candidatePaths.length; i += BATCH_SIZE) {
      const batchCandidates = candidatePaths.slice(i, i + BATCH_SIZE);
      const contracts = batchCandidates.map((candidate) => ({
        address: this.quoterAddress,
        abi: this.quoterAbi,
        functionName: 'quoteExactInput',
        args: [candidate.path, amountIn],
      }));

      try {
        const batchResults = (await this.publicClient.multicall({
          contracts,
          allowFailure: true,
        })) as Array<{ status: 'success' | 'failure'; result?: unknown; error?: Error }>;

        for (let j = 0; j < batchResults.length; j++) {
          const res = batchResults[j];
          if (res.status === 'success' && res.result) {
            const [amountOut, , , gasEstimate] = res.result as [
              bigint,
              readonly bigint[],
              readonly number[],
              bigint
            ];
            if (amountOut > 0n) {
              validQuotes.push({
                path: batchCandidates[j].path,
                amountOut,
                hops: batchCandidates[j].hops,
                gasEstimate,
                description: batchCandidates[j].desc,
              });
            }
          }
        }
      } catch (err: any) {
        logger.warn(
          `SmartRouter multicall batch error for ${tokenIn} -> ${tokenOut}: ${err.message}`
        );
      }
    }

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

  getCacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
