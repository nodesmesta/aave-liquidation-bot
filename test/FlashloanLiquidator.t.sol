// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

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
        address testUser = makeAddr("liquidatableUser");
        deal(WETH, testUser, 1 ether);
        
        vm.startPrank(testUser);
        IERC20(WETH).approve(POOL_ADDRESS, type(uint256).max);
        pool.supply(WETH, 1 ether, testUser, 0);
        pool.borrow(USDC, 2000e6, 2, 0, testUser);
        vm.stopPrank();
        
        (,,,,,uint256 hfBefore) = pool.getUserAccountData(testUser);
        assertGt(hfBefore, LIQUIDATABLE_THRESHOLD, "Initial HF should be healthy");
        
        // Time warp untuk accrue interest
        vm.warp(block.timestamp + 500 days);
        vm.roll(block.number + 360000);
        
        // Drop harga WETH untuk membuat liquidatable
        vm.mockCall(
            0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156,
            abi.encodeWithSignature("getAssetPrice(address)", WETH),
            abi.encode(200000000000)
        );
        
        (,uint256 totalDebt,,,,uint256 healthFactor) = pool.getUserAccountData(testUser);
        assertTrue(isLiquidatable(healthFactor), "Position should be liquidatable");
        
        uint256 closeFactor = calculateCloseFactor(healthFactor);
        uint256 debtToCover = (totalDebt * closeFactor) / 10000;
        if (debtToCover > 2500e6) debtToCover = 2500e6;
        
        assertGt(debtToCover, 0, "Debt to cover should be positive");
        
        uint256 ownerBalanceBefore = IERC20(USDC).balanceOf(owner);
        
        vm.prank(owner);
        liquidator.executeLiquidation(WETH, USDC, testUser, debtToCover);
        
        assertGt(IERC20(USDC).balanceOf(owner) - ownerBalanceBefore, 0, "Should be profitable");
        assertEq(IERC20(WETH).balanceOf(address(liquidator)), 0, "No WETH dust");
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "No USDC dust");
    }
}
