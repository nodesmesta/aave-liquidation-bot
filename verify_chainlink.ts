import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
});

async function verify() {
  const CHAINLINK = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
  
  console.log('1. Checking if address has code...');
  const code = await client.getCode({ address: CHAINLINK });
  console.log(`   ✓ Has code: ${code ? 'Yes' : 'No'}`);
  
  console.log('\n2. Checking last 10 blocks for AnswerUpdated event...');
  const currentBlock = await client.getBlockNumber();
  console.log(`   Current block: ${currentBlock}`);
  
  try {
    const events = await client.getLogs({
      address: CHAINLINK,
      event: parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)'),
      fromBlock: currentBlock - 10n,
      toBlock: currentBlock,
    });
    console.log(`   ✓ Found ${events.length} events in last 10 blocks`);
  } catch (e: any) {
    console.log(`   ✗ Error: ${e.message}`);
  }
  
  console.log('\n3. Checking if contract responds to aggregator interface...');
  try {
    const data = await client.readContract({
      address: CHAINLINK,
      abi: [{
        name: 'latestRoundData',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          { name: 'roundId', type: 'uint80' },
          { name: 'answer', type: 'int256' },
          { name: 'startedAt', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
          { name: 'answeredInRound', type: 'uint80' }
        ]
      }],
      functionName: 'latestRoundData',
    });
    console.log(`   ✓ Contract is a Chainlink Aggregator`);
    console.log(`   Latest answer: ${data[1]}`);
    console.log(`   Updated at: ${new Date(Number(data[3]) * 1000).toISOString()}`);
  } catch (e: any) {
    console.log(`   ✗ Not a Chainlink aggregator: ${e.message}`);
  }
}

verify().catch(console.error);
