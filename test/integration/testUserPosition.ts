import { createPublicClient, createWalletClient, http, parseAbi, Address, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { OptimizedLiquidationService } from '../../src/services/OptimizedLiquidationService';
import { HealthChecker, UserHealth } from '../../src/services/HealthChecker';

const USER_ADDRESS = process.env.USER_ADDRESS || '0x605556590408b5c0a3336d0e1d71464212dd0fbb';
const SIMULATED_HF = parseFloat(process.env.SIMULATED_HF || '0.95');
const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const PROTOCOL_DATA_PROVIDER = '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac';
const POOL_ADDRESS = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const ORACLE_ADDRESS = '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156';
const EXECUTE_LIQUIDATION = process.env.EXECUTE_LIQUIDATION === 'true';

// Liquidator contract address from deployment
const LIQUIDATOR_ADDRESS = (process.env.LIQUIDATOR_CONTRACT_ADDRESS || '0x1eF26FE672e5Bd6af8D9f4B7519B7559626454F7') as Address;

function log(section: string, message: string = '') {
  if (section && !message) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(section);
    console.log('='.repeat(60));
  } else if (section && message) {
    console.log(`${section}: ${message}`);
  } else {
    console.log('');
  }
}

async function testBotFlow() {
  try {
    // Validate input
    if (!USER_ADDRESS.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid USER_ADDRESS format');
    }

    log('Bot Flow Test - Real User Liquidation');
    console.log(`User: ${USER_ADDRESS}`);
    console.log(`Target HF: ${SIMULATED_HF} (assuming liquidatable)`);

    const publicClient = createPublicClient({
      chain: base,
      transport: http(RPC_URL),
    });

    // Step 1: Query current health (like bot does)
    log('Step 1: Health Check (HealthChecker.checkUsers)');
    
    // Create HealthChecker dengan explicit RPC dan Pool address
    const healthChecker = new HealthChecker(RPC_URL, POOL_ADDRESS);
    
    // But for test, manually query since HealthChecker uses basePreconf
    const poolAbi = parseAbi([
      'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
    ]);
    
    const healthCheckStart = Date.now();
    const multicallResults = await publicClient.multicall({
      contracts: [{
        address: POOL_ADDRESS as Address,
        abi: poolAbi,
        functionName: 'getUserAccountData',
        args: [USER_ADDRESS as Address],
      }],
    });
    const healthCheckLatency = Date.now() - healthCheckStart;

    if (multicallResults[0].status !== 'success') {
      console.log('\n❌ User has no active position or health check failed');
      process.exit(1);
    }

    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = 
      multicallResults[0].result as [bigint, bigint, bigint, bigint, bigint, bigint];

    const collateralUSD = Number(totalCollateralBase) / 1e8;
    const debtUSD = Number(totalDebtBase) / 1e8;
    const currentHF = Number(healthFactor) / 1e18;

    console.log(`   Health check completed in ${healthCheckLatency}ms`);
    console.log(`   Collateral: $${collateralUSD.toFixed(2)}`);
    console.log(`   Debt: $${debtUSD.toFixed(2)}`);
    console.log(`   Health Factor: ${currentHF.toFixed(4)}`);
    console.log(`   LTV: ${(Number(ltv) / 100).toFixed(2)}%`);
    console.log(`   Status: ${currentHF < 1.0 ? '🔴 LIQUIDATABLE' : '🟢 HEALTHY'}`);

    // Step 2: Filter liquidatable users (like bot does)
    log('Step 2: Filter Liquidatable Users');

    let liquidatableUsers: UserHealth[];
    
    if (currentHF >= 1.0) {
      console.log(`   Original HF: ${currentHF.toFixed(4)} (healthy)`);
      console.log(`   Simulating liquidatable state with HF: ${SIMULATED_HF}`);
      
      // Mock user as liquidatable
      liquidatableUsers = [{
        user: USER_ADDRESS,
        healthFactor: SIMULATED_HF,
        totalCollateralBase,
        totalDebtBase,
        availableBorrowsBase,
        currentLiquidationThreshold,
        ltv,
        status: 'LIQUIDATABLE' as const,
      }];
    } else {
      console.log(`   User is actually liquidatable (HF: ${currentHF.toFixed(4)})`);
      liquidatableUsers = [{
        user: USER_ADDRESS,
        healthFactor: currentHF,
        totalCollateralBase,
        totalDebtBase,
        availableBorrowsBase,
        currentLiquidationThreshold,
        ltv,
        status: 'LIQUIDATABLE' as const,
      }];
    }

    console.log(`   Liquidatable users: ${liquidatableUsers.length}`);

    // Step 3: Check in-flight liquidations (simulate bot's check)
    log('Step 3: Check In-Flight Liquidations');
    
    const inFlightLiquidations = new Set<string>(); // Empty set for test
    const availableUsers = liquidatableUsers.filter(user => {
      if (inFlightLiquidations.has(user.user)) {
        console.log(`   Skipping ${user.user} - already in-flight`);
        return false;
      }
      return true;
    });

    console.log(`   Available for liquidation: ${availableUsers.length}`);

    if (availableUsers.length === 0) {
      console.log('\n❌ No users available for liquidation');
      process.exit(1);
    }

    // Step 4: Select best liquidation (bot's selectBestLiquidation)
    log('Step 4: Select Best Liquidation');
    
    const service = new OptimizedLiquidationService(RPC_URL, PROTOCOL_DATA_PROVIDER);
    
    console.log(`   Fetching liquidation params for ${availableUsers.length} users...`);
    const paramsStart = Date.now();
    const paramsMap = await service.getLiquidationParamsForMultipleUsers(availableUsers);
    const paramsLatency = Date.now() - paramsStart;

    if (paramsMap.size === 0) {
      console.log('\n❌ No valid liquidations found');
      console.log('   Possible reasons:');
      console.log('   - Collateral too small (< $10 liquidation value)');
      console.log('   - Estimated value < $100 minimum');
      console.log('   - No profitable pairs available');
      process.exit(1);
    }

    // Sort by estimated value (like bot does)
    const validLiquidations = Array.from(paramsMap.values());
    validLiquidations.sort((a, b) => {
      const valueDiff = b.params.estimatedValue - a.params.estimatedValue;
      if (Math.abs(valueDiff) > 50) return valueDiff;
      return a.userHealth.healthFactor - b.userHealth.healthFactor;
    });

    const best = validLiquidations[0];
    
    console.log(`   Found ${validLiquidations.length} valid liquidation(s)`);
    console.log(`   Params fetch completed in ${paramsLatency}ms`);
    console.log(`   Selected best: ${best.params.collateralSymbol}→${best.params.debtSymbol}`);
    console.log(`   HF: ${best.userHealth.healthFactor.toFixed(4)}`);
    console.log(`   Value: $${best.params.estimatedValue.toFixed(2)}`);

    // Step 5: Display execution parameters (what bot would execute)
    log('Step 5: Execution Parameters (Ready to Execute)');
    
    const { params } = best;

    console.log('\n   Transaction Parameters:');
    console.log(`   • collateralAsset: ${params.collateralAsset}`);
    console.log(`   • debtAsset: ${params.debtAsset}`);
    console.log(`   • user: ${params.userAddress}`);
    console.log(`   • debtToCover: ${params.debtToCover.toString()}`);
    console.log(`   • estimatedValue: $${params.estimatedValue.toFixed(2)}`);

    console.log('\n   Liquidation Details:');
    console.log(`   • Collateral: ${params.collateralSymbol}`);
    console.log(`   • Debt: ${params.debtSymbol}`);
    console.log(`   • Bonus: ${params.liquidationBonus}%`);
    console.log(`   • Debt Value: $${params.debtToCoverUSD.toFixed(2)}`);
    console.log(`   • Estimated Profit: $${(params.estimatedValue - params.debtToCoverUSD).toFixed(2)}`);

    console.log('\n   Would execute:');
    console.log(`   executor.executeLiquidation(`);
    console.log(`     "${params.collateralAsset}",`);
    console.log(`     "${params.debtAsset}",`);
    console.log(`     "${params.userAddress}",`);
    console.log(`     ${params.debtToCover}n,`);
    console.log(`     ${params.estimatedValue}`);
    console.log(`   )`);

    // Step 6: Execute liquidation on smart contract (if enabled)
    if (EXECUTE_LIQUIDATION) {
      log('Step 6: Execute Smart Contract Liquidation');
      
      console.log(`   ⚠️  NOTE: Cannot execute on live network - user is healthy (HF: ${currentHF.toFixed(4)})`);
      console.log(`   ⚠️  Real liquidation only possible when HF < 1.0`);
      console.log(`   ℹ️  For full execution test with mock oracle, run Foundry test:`);
      console.log(`   ℹ️  forge test --match-test testSmartContractLiquidationFlow -vv`);
      console.log(`\n   Contract deployed at: ${LIQUIDATOR_ADDRESS}`);
      
    } else {
      console.log('\n   ℹ️  Smart contract execution disabled');
      console.log('   Contract deployed at: ' + LIQUIDATOR_ADDRESS);
      console.log('   For Foundry test with mock oracle execution:');
      console.log('   forge test --match-test testSmartContractLiquidationFlow -vv');
    }

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

testBotFlow();
