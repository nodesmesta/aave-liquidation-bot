import { createPublicClient, http, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../src/config';
import { AssetManager } from '../src/services/AssetManager';
import { SubgraphService } from '../src/services/SubgraphService';
import { logger } from '../src/utils/logger';

async function main() {
  logger.info('Starting Subgraph HF pre-filtering test...');

  const customChain: Chain = {
    ...basePreconf,
    rpcUrls: {
      ...basePreconf.rpcUrls,
      default: { http: [config.network.rpcUrl] },
    },
  } as Chain;

  const publicClient = createPublicClient({
    chain: customChain,
    transport: http(config.network.rpcUrl),
  });

  const assetManager = new AssetManager(publicClient, config.aave.protocolDataProvider);
  const subgraphService = new SubgraphService(config.aave.subgraphUrl, publicClient, assetManager);

  logger.info('Initializing AssetManager...');
  await assetManager.initialize();

  logger.info('Fetching active borrowers and estimating local HF...');
  const startTime = Date.now();
  const candidates = await subgraphService.getActiveBorrowers();
  const elapsed = Date.now() - startTime;

  logger.info(`Test complete in ${elapsed}ms: Found ${candidates.size} candidates with Estimated HF < 1.5.`);
  
  if (candidates.size > 0) {
    const firstCandidate = Array.from(candidates.keys())[0];
    logger.info(`Sample candidate: ${firstCandidate} | Debt Assets: ${candidates.get(firstCandidate)?.join(', ')}`);
  } else {
    logger.info('No candidates found. (This might be normal depending on market conditions)');
  }
}

main().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});
