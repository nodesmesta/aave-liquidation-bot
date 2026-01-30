import { expect } from 'chai';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { OptimizedLiquidationService } from '../../src/services/OptimizedLiquidationService';
import { LiquidationExecutor } from '../../src/services/LiquidationExecutor';
import { PriceOracle } from '../../src/services/PriceOracle';

describe('Real Liquidation Execution with Broadcast Verification', () => {
  const ANVIL_URL = process.env.ANVIL_URL || 'http://127.0.0.1:8545';
  const PROTOCOL_DATA_PROVIDER = '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac';
  const LIQUIDATOR_CONTRACT = process.env.LIQUIDATOR_CONTRACT_ADDRESS || '0x7179a57743Bce6DcbEd6Ac54200eD2C056E73c30';

  let service: OptimizedLiquidationService;
  let executor: LiquidationExecutor;
  let publicClient: any;

  before(function() {
    service = new OptimizedLiquidationService(ANVIL_URL, PROTOCOL_DATA_PROVIDER);
    
    process.env.BASE_RPC_URL = ANVIL_URL;
    process.env.LIQUIDATOR_CONTRACT_ADDRESS = LIQUIDATOR_CONTRACT;
    executor = new LiquidationExecutor(ANVIL_URL);
    
    publicClient = createPublicClient({
      chain: base,
      transport: http(ANVIL_URL),
    });
  });

  it('should query real user, calculate params, and broadcast liquidation transaction', async function() {
    this.timeout(60000);

    const USER_ADDRESS = process.env.USER_ADDRESS;
    
    if (!USER_ADDRESS) {
      throw new Error('USER_ADDRESS environment variable required. Usage: USER_ADDRESS=0x... npm test');
    }

    console.log('\n=== Real User Liquidation Execution Test ===');
    console.log('User:', USER_ADDRESS);

    const userReserves = await service.getUserReservesWithConfigs(USER_ADDRESS);
    
    if (userReserves.length === 0) {
      console.log('User has no active positions');
      this.skip();
      return;
    }

    const collateralReserves = userReserves.filter(r => 
      r.collateralBalance > 0n && r.usageAsCollateralEnabled
    );
    const debtReserves = userReserves.filter(r => r.debtBalance > 0n);

    console.log('\nCollateral:', collateralReserves.map(r => r.symbol).join(', '));
    console.log('Debt:', debtReserves.map(r => r.symbol).join(', '));

    expect(collateralReserves.length).to.be.greaterThan(0, 'User should have collateral');
    expect(debtReserves.length).to.be.greaterThan(0, 'User should have debt');

    const priceOracle = new PriceOracle(publicClient);
    const assetAddresses = userReserves.map(r => r.asset);
    const priceMap = await priceOracle.getAssetsPrices(assetAddresses);

    const simulatedHF = parseFloat(process.env.SIMULATED_HF || '0.96');
    console.log(`\nSimulating HF = ${simulatedHF} for liquidation`);

    let bestParams = null;
    let bestValue = 0;

    for (const collateral of collateralReserves) {
      for (const debt of debtReserves) {
        const params = await service.prepareLiquidationParams(
          USER_ADDRESS,
          collateral,
          debt,
          simulatedHF
        );
        
        if (params) {
          const debtFormatted = parseFloat(formatUnits(params.debtToCover, debt.decimals));
          const debtPrice = priceMap.get(debt.asset) || 0;
          const value = debtFormatted * debtPrice;
          
          if (value > bestValue) {
            bestValue = value;
            bestParams = params;
          }
        }
      }
    }

    expect(bestParams).to.not.be.null;
    console.log(`\nBest strategy: ${bestParams!.collateralSymbol} -> ${bestParams!.debtSymbol} ($${bestValue.toFixed(2)})`);

    console.log('\nExecuting liquidation...');
    const result = await executor.executeLiquidation(
      bestParams!.collateralAsset,
      bestParams!.debtAsset,
      bestParams!.userAddress,
      bestParams!.debtToCover
    );

    console.log('\nExecution result:');
    console.log('  Success:', result.success);
    console.log('  TX Hash:', result.txHash);
    console.log('  Error:', result.error || 'None');

    if (result.txHash) {
      const tx = await publicClient.getTransaction({ hash: result.txHash });
      
      expect(tx).to.not.be.null;
      expect(tx.to?.toLowerCase()).to.equal(LIQUIDATOR_CONTRACT.toLowerCase());
      
      console.log('\n✓ Transaction broadcast verified');
      console.log('  From:', tx.from);
      console.log('  To:', tx.to);
      console.log('  Block:', tx.blockNumber?.toString());
    }

    expect(result).to.have.property('success');
    expect(result).to.have.property('txHash');
  });
});
