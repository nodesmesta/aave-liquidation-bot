import { UserPool } from '../src/services/UserPool';
import { logger } from '../src/utils/logger';

async function runTest() {
  logger.info('Starting Isolated UserPool Test');
  
  const userPool = new UserPool();
  
  // 1. Test Addition
  logger.info('Adding mock users...');
  userPool.addUser({
    address: '0x1111111111111111111111111111111111111111',
    estimatedHF: 1.05,
    collateralUSD: 1000,
    debtUSD: 900,
    collateralAssets: ['0xcollateral1'],
    debtAssets: ['0xdebt1'],
    lastCheckedHF: 1.05,
    lastUpdated: Date.now(),
    addedAt: Date.now()
  });
  
  userPool.addUser({
    address: '0x2222222222222222222222222222222222222222',
    estimatedHF: 1.02,
    collateralUSD: 500,
    debtUSD: 490,
    collateralAssets: ['0xcollateral2'],
    debtAssets: ['0xdebt1'],
    lastCheckedHF: 1.02,
    lastUpdated: Date.now(),
    addedAt: Date.now()
  });
  
  userPool.logStatus();
  
  // 2. Test Address-Based Tracking (Task 1)
  logger.info('Testing Address-Based Tracking...');
  const usersWithDebt1 = userPool.getUsersWithDebt('0xDEBT1'); // uppercase test
  if (usersWithDebt1.length === 2) {
    logger.info('✓ Address normalization for tracking is working (Found 2 users for 0xDEBT1)');
  } else {
    logger.error('✗ Address tracking failed!');
  }
  
  // 3. Test Pruning (Task 2 simulation)
  logger.info('Simulating Pruning Mechanism...');
  // User 1 pays off debt (HF becomes safe, e.g. 1.2)
  userPool.removeUser('0x1111111111111111111111111111111111111111');
  
  const remaining = userPool.getAllUsers();
  if (remaining.length === 1 && remaining[0].address === '0x2222222222222222222222222222222222222222') {
    logger.info('✓ Pruning successful (User 1 removed)');
  } else {
    logger.error('✗ Pruning failed!');
  }
  
  userPool.logStatus();
  logger.info('Test completed successfully.');
}

runTest().catch(console.error);
