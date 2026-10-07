import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { SmartRouter } from '../src/services/SmartRouter';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const router = new SmartRouter(client);

  const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
  const WEETH = '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WETH = '0x4200000000000000000000000000000000000006';

  console.log('--- TEST 1: Routing cbBTC -> weETH (The problematic pair) ---');
  const amountInCbBtc = 38128n; // ~0.00038 cbBTC (~$32 USD)
  const start1 = Date.now();
  const route1 = await router.getBestRoute(CBBTC, WEETH, amountInCbBtc);
  const latency1 = Date.now() - start1;

  console.log('Result 1:');
  console.log('  Description:', route1?.description);
  console.log('  Amount Out: ', route1?.amountOut.toString());
  console.log('  Hops:       ', route1?.hops);
  console.log('  Path hex:   ', route1?.path);
  console.log(`  Initial RPC Latency: ${latency1}ms`);

  console.log('\n--- TEST 2: Cache Lookup for cbBTC -> weETH ---');
  const startCache = performance.now();
  const cachedRoute = await router.getBestRoute(CBBTC, WEETH, amountInCbBtc);
  const latencyCache = performance.now() - startCache;
  console.log(`  Cached Latency: ${latencyCache.toFixed(3)}ms`);
  console.log('  Same path:', cachedRoute?.path === route1?.path);

  console.log('\n--- TEST 3: Routing cbBTC -> USDC ---');
  const start3 = Date.now();
  const route3 = await router.getBestRoute(CBBTC, USDC, 1000000n); // 0.01 cbBTC
  console.log('Result 3:');
  console.log('  Description:', route3?.description);
  console.log('  Amount Out: ', route3?.amountOut.toString());
  console.log('  Hops:       ', route3?.hops);
  console.log(`  RPC Latency: ${Date.now() - start3}ms`);

  console.log('\n--- ALL ROUTER TESTS COMPLETED SUCCESSFULLY ---');
}

main().catch(console.error);
