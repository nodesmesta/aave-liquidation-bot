/**
 * Performance profiling script for liquidation execution
 * Usage: USER_ADDRESS=0x... npx ts-node scripts/profileLiquidation.ts
 */

import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { OptimizedLiquidationService } from '../../src/services/OptimizedLiquidationService';
import { HealthChecker } from '../../src/services/HealthChecker';
import { GasManager } from '../../src/services/GasManager';
import { NonceManager } from '../../src/services/NonceManager';
import { config } from '../../src/config';

async function main() {
  const USER_ADDRESS = process.env.USER_ADDRESS;
  
  if (!USER_ADDRESS) {
    console.error('❌ USER_ADDRESS required');
    console.log('Usage: USER_ADDRESS=0x... npx ts-node scripts/profileLiquidation.ts');
    process.exit(1);
  }

  const RPC_URL = config.network.rpcUrl;
  const DUMMY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil default key for test
  const account = privateKeyToAccount(DUMMY_KEY as `0x${string}`);
  
  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  console.log('\n=== Performance Profile Test ===');
  console.log('User:', USER_ADDRESS);
  console.log('Wallet:', account.address);
  console.log('RPC:', RPC_URL.includes('alchemy') ? 'Alchemy' : 'Custom');
  console.log('━'.repeat(60));

  const service = new OptimizedLiquidationService(RPC_URL, config.aave.protocolDataProvider);
  const healthChecker = new HealthChecker(RPC_URL, config.aave.pool);
  const gasManager = new GasManager(publicClient, config.network.wssUrl);
  const nonceManager = new NonceManager(publicClient as any, account.address);

  // Stage 1: Health Check
  const t0 = Date.now();
  const healthMap = await healthChecker.checkUsers([USER_ADDRESS]);
  const t1 = Date.now();
  const healthLatency = t1 - t0;
  
  let health = healthMap.get(USER_ADDRESS);
  if (!health) {
    console.log('❌ User not found or no position');
    process.exit(1);
  }

  console.log(`\n✓ [1/6] Health Check: ${healthLatency}ms`);
  console.log(`   Actual HF: ${health.healthFactor.toFixed(4)}`);
  
  // Force simulate liquidatable HF for timing test
  const SIMULATED_HF = 0.95;
  health = {
    ...health,
    healthFactor: SIMULATED_HF
  };
  console.log(`   Simulated HF: ${SIMULATED_HF} (for test)`);

  // Stage 2: Fetch Liquidation Params
  const t2 = Date.now();
  const paramsMap = await service.getLiquidationParamsForMultipleUsers([health]);
  const t3 = Date.now();
  const paramsLatency = t3 - t2;
  
  let userParams = paramsMap.get(USER_ADDRESS);
  
  // If no params (user recovered), still continue with mock data for timing
  if (!userParams) {
    console.log(`\n✓ [2/6] Fetch Params: ${paramsLatency}ms`);
    console.log(`   No valid params - using mock data for timing test`);
    
    // Create mock params to continue timing test
    userParams = {
      params: {
        userAddress: USER_ADDRESS,
        collateralAsset: '0x0000000000000000000000000000000000000001',
        collateralSymbol: 'MOCK',
        debtAsset: '0x0000000000000000000000000000000000000002',
        debtSymbol: 'MOCK',
        debtToCover: 100000000n,
        debtToCoverUSD: 100,
        liquidationBonus: 5,
        estimatedValue: 105,
      },
      userHealth: health
    };
  } else {
    console.log(`\n✓ [2/6] Fetch Params: ${paramsLatency}ms`);
    console.log(`   ${userParams.params.collateralSymbol} → ${userParams.params.debtSymbol}`);
    console.log(`   Value: $${userParams.params.estimatedValue.toFixed(2)}`);
  }

  // Stage 3: Get Balance
  const t4 = Date.now();
  const balance = await publicClient.getBalance({ address: account.address });
  const t5 = Date.now();
  const balanceLatency = t5 - t4;
  const balanceETH = Number(formatEther(balance));

  console.log(`\n✓ [3/6] Get Balance: ${balanceLatency}ms`);
  console.log(`   Balance: ${balanceETH.toFixed(6)} ETH`);

  // Stage 4: Gas Settings
  await gasManager.initialize();
  
  const t6 = Date.now();
  const gasSettings = await gasManager.getOptimalGasSettings(
    920000n,
    userParams.params.estimatedValue
  );
  const t7 = Date.now();
  const gasLatency = t7 - t6;

  console.log(`\n✓ [4/6] Gas Settings: ${gasLatency}ms`);
  console.log(`   Priority: ${(Number(gasSettings.maxPriorityFeePerGas) / 1e9).toFixed(4)} gwei`);
  console.log(`   MaxFee: ${(Number(gasSettings.maxFeePerGas) / 1e9).toFixed(4)} gwei`);

  // Stage 5: Get Nonce
  await nonceManager.initialize();
  
  const t8 = Date.now();
  const { nonce } = await nonceManager.getNextNonce();
  const t9 = Date.now();
  const nonceLatency = t9 - t8;

  console.log(`\n✓ [5/6] Get Nonce: ${nonceLatency}ms`);
  console.log(`   Nonce: ${nonce}`);

  // Stage 6: Simulate TX preparation (no actual broadcast)
  console.log(`\n⏳ [6/6] Simulating TX preparation...`);
  
  const t10 = Date.now();
  // Simulate TX building without broadcasting
  const txRequest = {
    to: config.liquidator.address as `0x${string}`,
    data: '0x', // Simplified for timing test
    nonce: nonce,
    maxFeePerGas: gasSettings.maxFeePerGas,
    maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas,
    gas: gasSettings.gas,
  };
  const t11 = Date.now();
  const writeLatency = t11 - t10;

  console.log(`\n✓ [6/6] TX preparation simulated: ${writeLatency}ms`);
  console.log(`   (No actual TX broadcast for test safety)`);

  // Summary
  const totalLatency = t11 - t0;
  const dataFetchLatency = healthLatency + paramsLatency;
  const txPrepLatency = balanceLatency + gasLatency + nonceLatency + writeLatency;

  console.log('\n' + '━'.repeat(60));
  console.log('📈 PERFORMANCE SUMMARY');
  console.log('━'.repeat(60));
  console.log(`Health Check:       ${healthLatency.toString().padStart(6)}ms  (${((healthLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`Fetch Params:       ${paramsLatency.toString().padStart(6)}ms  (${((paramsLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`Get Balance:        ${balanceLatency.toString().padStart(6)}ms  (${((balanceLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`Gas Settings:       ${gasLatency.toString().padStart(6)}ms  (${((gasLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`Get Nonce:          ${nonceLatency.toString().padStart(6)}ms  (${((nonceLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`TX Prep (simulated): ${writeLatency.toString().padStart(5)}ms  (${((writeLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log('─'.repeat(60));
  console.log(`Data Fetch Total:   ${dataFetchLatency.toString().padStart(6)}ms  (${((dataFetchLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`TX Prep Total:      ${txPrepLatency.toString().padStart(6)}ms  (${((txPrepLatency/totalLatency)*100).toFixed(1)}%)`);
  console.log(`TOTAL TIME:         ${totalLatency.toString().padStart(6)}ms`);
  console.log('━'.repeat(60));

  // Bottleneck analysis
  const stages = [
    { name: 'Health Check', time: healthLatency },
    { name: 'Fetch Params', time: paramsLatency },
    { name: 'Get Balance', time: balanceLatency },
    { name: 'Gas Settings', time: gasLatency },
    { name: 'Get Nonce', time: nonceLatency },
    { name: 'writeContract', time: writeLatency },
  ];
  const bottleneck = stages.reduce((max, stage) => stage.time > max.time ? stage : max);

  console.log(`\n🎯 PRIMARY BOTTLENECK: ${bottleneck.name} (${bottleneck.time}ms - ${((bottleneck.time/totalLatency)*100).toFixed(1)}%)`);
  
  console.log('\n💡 NOTE: TX broadcast tidak dilakukan untuk keamanan test');
  console.log('   Untuk measure actual writeContract() time, jalankan di production dengan real TX');

  console.log('\n✅ Profile complete!\n');
  
  // Cleanup WebSocket
  gasManager.destroy();
  process.exit(0);
}

main().catch(console.error);
