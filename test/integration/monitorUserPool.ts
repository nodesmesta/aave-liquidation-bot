import * as fs from 'fs';
import * as path from 'path';

interface UserPoolSnapshot {
  timestamp: number;
  stats: {
    totalUsers: number;
    liquidatable: number;
    critical: number;
    warning: number;
    healthy: number;
    totalCollateralUSD: number;
    totalDebtUSD: number;
  };
  users: Array<{
    address: string;
    collateralAssets: string[];
    debtAssets: string[];
    collateralUSD: number;
    debtUSD: number;
    lastCheckedHF: number;
    lastUpdated: number;
    addedAt: number;
  }>;
}

async function monitorUserPool() {
  const snapshotPath = path.join(__dirname, '../../userpool_snapshot.json');

  console.log('='.repeat(70));
  console.log('AAVE V3 USER POOL MONITOR (Base Network)');
  console.log('='.repeat(70));
  console.log('');

  try {
    // Check if snapshot exists
    if (!fs.existsSync(snapshotPath)) {
      console.log('UserPool snapshot not found!');
      console.log('');
      console.log('Bot belum running atau belum export snapshot.');
      console.log('Snapshot path: ' + snapshotPath);
      console.log('');
      console.log('Bot akan otomatis export snapshot setiap 5 menit saat running.');
      process.exit(1);
    }

    // Read snapshot
    const snapshotData = fs.readFileSync(snapshotPath, 'utf-8');
    const snapshot: UserPoolSnapshot = JSON.parse(snapshotData);

    const snapshotAge = Date.now() - snapshot.timestamp;
    const ageMinutes = Math.floor(snapshotAge / 60000);
    const ageSeconds = Math.floor((snapshotAge % 60000) / 1000);

    console.log(`Snapshot Age: ${ageMinutes}m ${ageSeconds}s ago`);
    console.log(`Last Updated: ${new Date(snapshot.timestamp).toLocaleString()}`);
    console.log('');

    // Display summary
    const { stats, users } = snapshot;

    console.log('='.repeat(70));
    console.log('USER POOL SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total Users:           ${stats.totalUsers}`);
    console.log(`  - Liquidatable (HF < 1.0):    ${stats.liquidatable}`);
    console.log(`  - Critical (HF 1.0-1.05):     ${stats.critical}`);
    console.log(`  - Warning (HF 1.05-1.1):      ${stats.warning}`);
    console.log(`  - Healthy (HF >= 1.1):        ${stats.healthy}`);
    console.log('');
    console.log(`Total Collateral:      $${stats.totalCollateralUSD.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    console.log(`Total Debt:            $${stats.totalDebtUSD.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    
    if (users.length > 0) {
      const avgHF = users.reduce((sum, u) => sum + u.lastCheckedHF, 0) / users.length;
      console.log(`Average Health Factor: ${avgHF.toFixed(4)}`);
    }
    console.log('='.repeat(70));
    console.log('');

    // All users sorted by health factor
    const riskyUsers = users
      .sort((a, b) => a.lastCheckedHF - b.lastCheckedHF);

    if (riskyUsers.length === 0) {
      console.log('No users in pool');
      console.log('');
      return;
    }

    console.log(`ALL USERS (${riskyUsers.length} total, sorted by Health Factor)`);
    console.log('-'.repeat(110));
    console.log('Rank | Address                                      | HF      | Collateral    | Debt          | Status');
    console.log('-'.repeat(110));

    riskyUsers.forEach((user, idx) => {
      const status = user.lastCheckedHF < 1.0 ? 'LIQUIDATABLE' : user.lastCheckedHF < 1.03 ? 'CRITICAL' : user.lastCheckedHF < 1.075 ? 'WARNING' : 'HEALTHY';
      const rank = (idx + 1).toString().padStart(4);
      const hfStr = user.lastCheckedHF.toFixed(4).padStart(7);
      const collStr = `$${user.collateralUSD.toFixed(0)}`.padStart(13);
      const debtStr = `$${user.debtUSD.toFixed(0)}`.padStart(13);
      
      console.log(`${rank} | ${user.address} | ${hfStr} | ${collStr} | ${debtStr} | ${status}`);
    });
    console.log('-'.repeat(110));
    console.log('');

    const collateralAssetCount = new Map<string, number>();
    const debtAssetCount = new Map<string, number>();

    users.forEach(user => {
      user.collateralAssets.forEach(asset => {
        collateralAssetCount.set(asset, (collateralAssetCount.get(asset) || 0) + 1);
      });
      user.debtAssets.forEach(asset => {
        debtAssetCount.set(asset, (debtAssetCount.get(asset) || 0) + 1);
      });
    });

    console.log('ASSET DISTRIBUTION');
    console.log('-'.repeat(70));
    console.log('Collateral Assets:');
    Array.from(collateralAssetCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([asset, count]) => {
        console.log(`  ${asset}: ${count} users`);
      });
    
    console.log('');
    console.log('Debt Assets:');
    Array.from(debtAssetCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([asset, count]) => {
        console.log(`  ${asset}: ${count} users`);
      });
    console.log('='.repeat(70));
    console.log('');

  } catch (error: any) {
    console.error('Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

monitorUserPool();
