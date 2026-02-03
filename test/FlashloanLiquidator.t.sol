// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";
import {AaveOracleHelper} from "./helpers/AaveOracleHelper.sol";

interface IProtocolDataProvider {
    function getUserReserveData(address asset, address user) 
        external view returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        );
    
    function getReserveConfigurationData(address asset)
        external view returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        );
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

contract FlashloanLiquidatorTest is Test, BaseTestConfig {
    FlashloanLiquidator public liquidator;
    IPool public pool;
    IProtocolDataProvider public dataProvider;
    address public owner;
    address public user;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        owner = address(this);
        user = makeAddr("user");
        pool = IPool(POOL_ADDRESS);
        dataProvider = IProtocolDataProvider(DATA_PROVIDER);
        liquidator = new FlashloanLiquidator(POOL_ADDRESSES_PROVIDER, UNIVERSAL_ROUTER, DATA_PROVIDER, UNISWAP_FACTORY, PERMIT2);
    }

    function testDeployment() public view {
        assertEq(liquidator.owner(), owner);
        assertEq(address(liquidator.POOL()), POOL_ADDRESS);
        assertEq(address(liquidator.ADDRESSES_PROVIDER()), POOL_ADDRESSES_PROVIDER);
        assertEq(address(liquidator.UNIVERSAL_ROUTER()), UNIVERSAL_ROUTER);
    }

    function testOwnership() public {
        address newOwner = makeAddr("newOwner");
        liquidator.transferOwnership(newOwner);
        assertEq(liquidator.owner(), newOwner);
    }

    function testOnlyOwnerCanExecuteLiquidation() public {
        vm.prank(user);
        vm.expectRevert("Only owner");
        liquidator.executeLiquidation(WETH, USDC, user, 1000e6);
    }

    receive() external payable {}

    function testAaveV3SupplyAndBorrow() public {
        address testUser = makeAddr("testUser");
        deal(WETH, testUser, 2 ether);
        vm.startPrank(testUser);
        IERC20(WETH).approve(POOL_ADDRESS, type(uint256).max);
        pool.supply(WETH, 2 ether, testUser, 0);
        pool.borrow(USDC, 3000e6, 2, 0, testUser);
        vm.stopPrank();
        (, uint256 totalDebt, , , , uint256 healthFactor) = pool.getUserAccountData(testUser);
        assertTrue(healthFactor > LIQUIDATABLE_THRESHOLD);
        assertGt(totalDebt, 0);
    }

    function testRealLiquidationCase() public {
        RealLiquidationCase memory liqCase = getLiquidationCase1();
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), liqCase.blockNumber);
        liquidator = new FlashloanLiquidator(POOL_ADDRESSES_PROVIDER, UNIVERSAL_ROUTER, DATA_PROVIDER, UNISWAP_FACTORY, PERMIT2);
        (, , , , , uint256 healthFactor) = pool.getUserAccountData(liqCase.user);
        if (!isLiquidatable(healthFactor)) {
            return;
        }
        uint256 balanceBefore = IERC20(liqCase.collateralAsset).balanceOf(address(liquidator));
        vm.prank(owner);
        liquidator.executeLiquidation(
            liqCase.collateralAsset,
            liqCase.debtAsset,
            liqCase.user,
            liqCase.debtAmount
        );
        uint256 balanceAfter = IERC20(liqCase.collateralAsset).balanceOf(address(liquidator));
        assertGt(balanceAfter, balanceBefore);
    }

    function testUserCase2() public {
        RealLiquidationCase memory liqCase = getLiquidationCase2();
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        liquidator = new FlashloanLiquidator(POOL_ADDRESSES_PROVIDER, UNIVERSAL_ROUTER, DATA_PROVIDER, UNISWAP_FACTORY, PERMIT2);
        (uint256 totalCollateral, uint256 totalDebt, , , , uint256 healthFactor) = pool.getUserAccountData(liqCase.user);
        
        emit log_named_uint("Total Collateral (USD)", totalCollateral);
        emit log_named_uint("Total Debt (USD)", totalDebt);
        emit log_named_uint("Health Factor", healthFactor);
        emit log_named_address("User", liqCase.user);
        
        assertTrue(totalCollateral > 0, "User should have collateral");
        assertTrue(totalDebt > 0, "User should have debt");
        
        if (!isLiquidatable(healthFactor)) {
            emit log_string("User is HEALTHY - cannot be liquidated at current prices");
            return;
        }
        
        uint256 balanceBefore = IERC20(liqCase.collateralAsset).balanceOf(address(liquidator));
        vm.prank(owner);
        liquidator.executeLiquidation(
            liqCase.collateralAsset,
            liqCase.debtAsset,
            liqCase.user,
            liqCase.debtAmount
        );
        uint256 balanceAfter = IERC20(liqCase.collateralAsset).balanceOf(address(liquidator));
        assertGt(balanceAfter, balanceBefore);
    }

    function testCloseFactorCalculation() public pure {
        uint256 hfHigh = 0.98e18;
        uint256 hfLow = 0.92e18;
        assertEq(calculateCloseFactor(hfHigh), 5000);
        assertEq(calculateCloseFactor(hfLow), 10000);
    }

    function testDebtToCoverCalculation() public pure {
        uint256 totalDebt = 10000e6;
        uint256 hfHigh = 0.98e18;
        uint256 hfLow = 0.92e18;
        assertEq(calculateDebtToCover(totalDebt, hfHigh), 5000e6);
        assertEq(calculateDebtToCover(totalDebt, hfLow), 10000e6);
    }

    function testSmartContractLiquidationFlow() public {
        address testUser = 0x5e1d65a8893eF15bc8AcEdFC2e90826336Eb1dAD;
        address collateralAsset = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf; // cbBTC
        uint256 botCalculatedDebt = 3895634908;
        
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        liquidator = new FlashloanLiquidator(POOL_ADDRESSES_PROVIDER, UNIVERSAL_ROUTER, DATA_PROVIDER, UNISWAP_FACTORY, PERMIT2);
        
        // Get current health factor
        (, , , , , uint256 hfBefore) = pool.getUserAccountData(testUser);
        emit log_named_uint("Health Factor Before", hfBefore);
        
        // Get current cbBTC price from Aave Oracle
        IAaveOracle oracle = IAaveOracle(ORACLE);
        uint256 originalPrice = oracle.getAssetPrice(collateralAsset);
        emit log_named_uint("Original cbBTC Price", originalPrice);
        
        // Drop price by 20% to make position liquidatable
        uint256 newPrice = (originalPrice * 80) / 100;
        emit log_named_uint("New cbBTC Price (20% drop)", newPrice);
        
        // Mock oracle getAssetPrice to return lower price for cbBTC
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, collateralAsset),
            abi.encode(newPrice)
        );
        
        // Verify price changed
        uint256 priceAfter = oracle.getAssetPrice(collateralAsset);
        emit log_named_uint("Price After Mock", priceAfter);
        assertEq(priceAfter, newPrice, "Price should be mocked");
        
        // Check new health factor
        (, , , , , uint256 hfAfter) = pool.getUserAccountData(testUser);
        emit log_named_uint("Health Factor After", hfAfter);
        assertTrue(hfAfter < LIQUIDATABLE_THRESHOLD, "User should be liquidatable");
        
        // Execute liquidation with bot-calculated parameters
        // Check USDC profit received by owner
        uint256 usdcBalanceBefore = IERC20(USDC).balanceOf(owner);
        
        vm.prank(owner);
        liquidator.executeLiquidation(collateralAsset, USDC, testUser, botCalculatedDebt);
        
        uint256 usdcBalanceAfter = IERC20(USDC).balanceOf(owner);
        uint256 profit = usdcBalanceAfter - usdcBalanceBefore;
        
        emit log_named_uint("USDC Profit Received", profit);
        
        // Verify liquidation was successful and profitable
        assertGt(profit, 0, "Should receive USDC profit from liquidation");
        emit log_string("SUCCESS: Bot parameters correct, liquidation executed with profit!");
    }
}
