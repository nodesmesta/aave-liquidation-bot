// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

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
}

contract Simulate3UsersAutomatedTest is Test, BaseTestConfig {
    FlashloanLiquidator public liquidator;
    IPool public pool;
    IProtocolDataProvider public dataProvider;
    IAaveOracle public aaveOracle;

    address public constant USER_1 = 0x66bb6c2949b20503ADF3621db9903Ee52F92ffB5;
    address public constant USER_2 = 0x68421BA824A819a7f278e9D516717B2633aAaa6b;
    address public constant USER_3 = 0x34193EE789df1FfFd7F8EbE14EB2FDEA3642be8C;

    address public constant EURC_TOKEN = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address public constant WEETH_TOKEN = 0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A;

    address public owner;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        owner = address(this);
        pool = IPool(POOL_ADDRESS);
        dataProvider = IProtocolDataProvider(DATA_PROVIDER);
        aaveOracle = IAaveOracle(ORACLE);

        liquidator = new FlashloanLiquidator(
            POOL_ADDRESSES_PROVIDER,
            UNIVERSAL_ROUTER,
            DATA_PROVIDER,
            UNISWAP_FACTORY,
            PERMIT2
        );
    }

    receive() external payable {}

    /**
     * @notice Uji Eksekusi Otomatis User 1: 0x66bb6c29...
     * Bot secara otomatis memilih: Sita WETH -> Lunasi USDC via rute SmartRouter (WETH -> [500] -> USDC)
     */
    function testAutomatedLiquidationUser1() public {
        console.log("==================================================");
        console.log("TEST USER 1: 0x66bb6c29... (Sita WETH -> Lunasi USDC)");
        console.log("==================================================");

        // Ambil utang USDC user
        (, , uint256 usdcDebt, , , , , , ) = dataProvider.getUserReserveData(USDC, USER_1);
        console.log("USDC Total Debt Units:", usdcDebt);

        // Simulasikan pergerakan harga agar HF < 1.0 (WETH drop 15%)
        uint256 liveWethPrice = aaveOracle.getAssetPrice(WETH);
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH),
            abi.encode((liveWethPrice * 85) / 100)
        );

        (, , , , , uint256 hf) = pool.getUserAccountData(USER_1);
        console.log("Health Factor Target User 1:", hf);
        assertTrue(hf < 1.0e18, "User 1 harus berstatus likuidatabel (HF < 1.0)");

        // Parameter yang di-generate oleh Bot:
        uint256 debtToCover = usdcDebt / 2; // Close factor 50%
        // Rute swap yang di-generate secara otomatis oleh SmartRouter generik:
        bytes memory autoSwapPath = abi.encodePacked(WETH, uint24(500), USDC);

        uint256 usdcBalanceBefore = IERC20(USDC).balanceOf(owner);

        vm.prank(owner);
        liquidator.executeLiquidation(
            WETH,
            USDC,
            USER_1,
            debtToCover,
            autoSwapPath
        );

        uint256 usdcBalanceAfter = IERC20(USDC).balanceOf(owner);
        uint256 profitUSDC = usdcBalanceAfter - usdcBalanceBefore;

        console.log("HASIL EKSEKUSI USER 1 BERHASIL!");
        console.log("Profit Bersih Owner (USDC Units):", profitUSDC);
        console.log("Profit Bersih USD: $", profitUSDC / 1e6);
        assertGt(profitUSDC, 0, "Likuidasi User 1 harus menghasilkan profit positif");
    }

    /**
     * @notice Uji Eksekusi Otomatis User 2: 0x68421ba8...
     * Bot secara otomatis memilih rute Multi-Hop SmartRouter:
     * Sita WETH -> Lunasi cbBTC via Hub USDC (WETH -> [100] -> USDC -> [500] -> cbBTC)
     */
    function testAutomatedLiquidationUser2() public {
        console.log("\n==================================================");
        console.log("TEST USER 2: 0x68421ba8... (Sita WETH -> Lunasi cbBTC)");
        console.log("==================================================");

        (, , uint256 cbbtcDebt, , , , , , ) = dataProvider.getUserReserveData(CBBTC, USER_2);
        console.log("cbBTC Total Debt Units:", cbbtcDebt);

        // User 2 memiliki kolateral WETH ($22k) dan utang WETH ($13.9k) serta cbBTC ($7.6k).
        // Karena WETH self-hedged, simulasikan pergerakan pasar WETH drop 35% agar HF < 1.0
        uint256 liveWethPrice = aaveOracle.getAssetPrice(WETH);
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH),
            abi.encode((liveWethPrice * 65) / 100)
        );

        (, , , , , uint256 hf) = pool.getUserAccountData(USER_2);
        console.log("Health Factor Target User 2:", hf);
        assertTrue(hf < 1.0e18, "User 2 harus berstatus likuidatabel (HF < 1.0)");

        // Parameter yang di-generate oleh Bot:
        uint256 debtToCover = cbbtcDebt / 2; // Close factor 50%
        // Rute swap Multi-Hop yang di-generate oleh SmartRouter via routing hub USDC:
        bytes memory autoSwapPath = abi.encodePacked(
            WETH,
            uint24(100),
            USDC,
            uint24(500),
            CBBTC
        );

        uint256 cbbtcBalanceBefore = IERC20(CBBTC).balanceOf(owner);

        vm.prank(owner);
        liquidator.executeLiquidation(
            WETH,
            CBBTC,
            USER_2,
            debtToCover,
            autoSwapPath
        );

        uint256 cbbtcBalanceAfter = IERC20(CBBTC).balanceOf(owner);
        uint256 profitCbbtc = cbbtcBalanceAfter - cbbtcBalanceBefore;
        uint256 liveCbbtcPrice = aaveOracle.getAssetPrice(CBBTC);

        console.log("HASIL EKSEKUSI USER 2 BERHASIL!");
        console.log("Profit Bersih Owner (cbBTC units):", profitCbbtc);
        console.log("Profit Bersih USD (Perkiraan): $", (profitCbbtc * (liveCbbtcPrice / 1e8)) / 1e8);
        assertGt(profitCbbtc, 0, "Likuidasi User 2 harus menghasilkan profit positif");
    }

    /**
     * @notice Uji Eksekusi Otomatis User 3: 0x34193EE7...
     * Bot secara otomatis memilih: Sita weETH -> Lunasi WETH via rute SmartRouter (weETH -> [100] -> WETH)
     */
    function testAutomatedLiquidationUser3() public {
        console.log("\n==================================================");
        console.log("TEST USER 3: 0x34193EE7... (Sita weETH -> Lunasi WETH)");
        console.log("==================================================");

        (, , uint256 wethDebt, , , , , , ) = dataProvider.getUserReserveData(WETH, USER_3);
        console.log("WETH Total Debt Units:", wethDebt);

        // User 3 memiliki kolateral weETH ($1.046) dan utang WETH ($776).
        // Turunkan harga weETH sebesar 10% agar posisi undercollateralized (HF < 1.0)
        uint256 liveWeethPrice = aaveOracle.getAssetPrice(WEETH_TOKEN);
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WEETH_TOKEN),
            abi.encode((liveWeethPrice * 90) / 100)
        );

        (, , , , , uint256 hf) = pool.getUserAccountData(USER_3);
        console.log("Health Factor Target User 3:", hf);
        assertTrue(hf < 1.0e18, "User 3 harus berstatus likuidatabel (HF < 1.0)");

        // Parameter yang di-generate oleh Bot:
        // Untuk utang kecil (< $1.000) dan HF < 0.95, bot melunasi 100% utang (bebas dari MustNotLeaveDust)
        uint256 debtToCover = wethDebt;
        // Rute swap yang di-generate secara otomatis oleh SmartRouter generik:
        bytes memory autoSwapPath = abi.encodePacked(WEETH_TOKEN, uint24(100), WETH);

        uint256 wethBalanceBefore = IERC20(WETH).balanceOf(owner);

        vm.prank(owner);
        liquidator.executeLiquidation(
            WEETH_TOKEN,
            WETH,
            USER_3,
            debtToCover,
            autoSwapPath
        );

        uint256 wethBalanceAfter = IERC20(WETH).balanceOf(owner);
        uint256 profitWETH = wethBalanceAfter - wethBalanceBefore;
        uint256 liveWethPrice = aaveOracle.getAssetPrice(WETH);

        console.log("HASIL EKSEKUSI USER 3 BERHASIL!");
        console.log("Profit Bersih Owner (WETH wei):", profitWETH);
        console.log("Profit Bersih USD (Perkiraan): $", (profitWETH * (liveWethPrice / 1e8)) / 1e18);
        assertGt(profitWETH, 0, "Likuidasi User 3 harus menghasilkan profit positif");
    }
}
