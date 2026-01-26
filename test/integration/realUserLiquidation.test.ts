import { expect } from 'chai';
import { formatUnits } from 'viem';
import { OptimizedLiquidationService, LiquidationParams } from '../../src/services/OptimizedLiquidationService';
import { PriceOracle } from '../../src/services/PriceOracle';
describe('Real User Liquidation Test - On-Chain Data', () => {
  let service: OptimizedLiquidationService;
  const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const PROTOCOL_DATA_PROVIDER = '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac';
  before(() => {
    service = new OptimizedLiquidationService(RPC_URL, PROTOCOL_DATA_PROVIDER);
  });
  describe('Dynamic User Address Test', () => {
    it('should query REAL on-chain data and calculate optimal liquidation parameters', async function() {
      this.timeout(60000);
      const USER_ADDRESS = process.env.USER_ADDRESS;
      
      if (!USER_ADDRESS) {
        throw new Error('USER_ADDRESS environment variable is required. Usage: USER_ADDRESS=0x... npm test');
      }
      
      if (!USER_ADDRESS.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error('Invalid USER_ADDRESS format. Must be 0x followed by 40 hex characters');
      }
      console.log('\n=== Real User On-Chain Query ===');
      console.log(`User: ${USER_ADDRESS}`);
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
      console.log('\n--- Collateral ---');
      for (const reserve of collateralReserves) {
        const formatted = formatUnits(reserve.collateralBalance, reserve.decimals);
        console.log(`${reserve.symbol}: ${formatted}`);
      }
      console.log('\n--- Debt ---');
      for (const reserve of debtReserves) {
        const formatted = formatUnits(reserve.debtBalance, reserve.decimals);
        console.log(`${reserve.symbol}: ${formatted}`);
      }
      expect(collateralReserves.length).to.be.greaterThan(0, 'User should have collateral');
      expect(debtReserves.length).to.be.greaterThan(0, 'User should have debt');
      const priceOracle = new PriceOracle(RPC_URL);
      const assetAddresses = userReserves.map(r => r.asset);
      const priceMap = await priceOracle.getAssetsPrices(assetAddresses);
      let totalCollateralUSD = 0;
      let totalDebtUSD = 0;
      for (const reserve of collateralReserves) {
        const price = priceMap.get(reserve.asset) || 0;
        const amount = parseFloat(formatUnits(reserve.collateralBalance, reserve.decimals));
        totalCollateralUSD += amount * price;
      }
      for (const reserve of debtReserves) {
        const price = priceMap.get(reserve.asset) || 0;
        const amount = parseFloat(formatUnits(reserve.debtBalance, reserve.decimals));
        totalDebtUSD += amount * price;
      }
      const currentHF = totalDebtUSD > 0 ? totalCollateralUSD / totalDebtUSD : 999;
      console.log(`\nCollateral: $${totalCollateralUSD.toFixed(2)} | Debt: $${totalDebtUSD.toFixed(2)} | HF: ${currentHF.toFixed(3)}`);
      const simulatedHF = parseFloat(process.env.SIMULATED_HF || '0.96');
      console.log(`Simulating HF = ${simulatedHF} for liquidation test\n`);
      let bestParams: LiquidationParams | null = null;
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
            const debtFormatted = parseFloat(
              formatUnits(params.debtToCover, debt.decimals)
            );
            const debtPrice = priceMap.get(debt.asset) || 0;
            const value = debtFormatted * debtPrice;
            console.log(`${collateral.symbol} → ${debt.symbol}: $${value.toFixed(2)}`);
            if (value > bestValue) {
              bestValue = value;
              bestParams = params;
            }
          }
        }
      }
      expect(bestParams).to.not.be.null;
      expect(bestParams!.debtToCover).to.exist;
      expect(bestValue).to.be.greaterThan(0);
      console.log(`\nSelected: ${bestParams!.collateralSymbol} -> ${bestParams!.debtSymbol} ($${bestValue.toFixed(2)})`);
      console.log(`\nexecuteLiquidation(`);
      console.log(`  collateralAsset: "${bestParams!.collateralAsset}",`);
      console.log(`  debtAsset: "${bestParams!.debtAsset}",`);
      console.log(`  user: "${USER_ADDRESS}",`);
      console.log(`  debtToCover: ${bestParams!.debtToCover.toString()}`);
      console.log(`)`);
      const estimatedProfit = bestValue * (bestParams!.liquidationBonus / 100);
      console.log(`\nProfit: $${estimatedProfit.toFixed(2)} (${bestParams!.liquidationBonus}% bonus)`);
      if (bestParams!.collateralAsset === bestParams!.debtAsset) {
        console.log(`Same asset - NO SWAP needed!`);
      }
    });
  });
});
