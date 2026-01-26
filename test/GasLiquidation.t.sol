// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

/**
 * @title GasLiquidation Test
 * @notice Measures actual gas consumption for successful liquidation execution
 * @dev Uses real on-chain data from Base mainnet with forced price manipulation
 */
contract GasLiquidationTest is Test, BaseTestConfig {
    FlashloanLiquidator public liquidator;
    IPool public pool;
    address public owner;
    
    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), 41186135);
        owner = address(this);
        pool = IPool(POOL_ADDRESS);
        liquidator = new FlashloanLiquidator(
            POOL_ADDRESSES_PROVIDER, 
            UNIVERSAL_ROUTER, 
            DATA_PROVIDER, 
            UNISWAP_FACTORY, 
            PERMIT2
        );
    }
    
    /**
     * @notice Test gas consumption for full liquidation flow
     * @dev Uses real user with WETH collateral and USDC debt
     *      Manipulates ETH price to force HF below 1.0
     */
    function testGasConsumptionFullLiquidation() public {
        address user = 0x9a08624B5D57c00FDa407de2dea43450B9A0a243;
        
        // Check initial health factor
        (,,,,, uint256 hfBefore) = pool.getUserAccountData(user);
        assertGt(hfBefore, LIQUIDATABLE_THRESHOLD, "User should be healthy initially");
        
        // Mock oracle to manipulate ETH price DOWN to trigger liquidation
        // WETH price oracle: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
        address ethPriceAggregator = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
        
        // Current price ~$2937, set to $1900 to force HF < 1.0
        int256 manipulatedPrice = 190000000000; // $1900 with 8 decimals
        
        vm.mockCall(
            ethPriceAggregator,
            abi.encodeWithSelector(bytes4(keccak256("latestAnswer()"))),
            abi.encode(manipulatedPrice)
        );
        
        // Verify HF is now liquidatable
        (,,,,, uint256 hfAfter) = pool.getUserAccountData(user);
        assertLt(hfAfter, LIQUIDATABLE_THRESHOLD, "User should be liquidatable after price drop");
        
        // Calculate liquidation parameters
        uint256 debtToCover = 1176617618; // From real liquidation case
        
        // Execute liquidation with gas tracking
        uint256 gasBefore = gasleft();
        
        vm.prank(owner);
        liquidator.executeLiquidation(
            WETH,      // collateralAsset
            USDC,      // debtAsset  
            user,      // user
            debtToCover // debtToCover
        );
        
        uint256 gasUsed = gasBefore - gasleft();
        
        // Verify liquidation success
        assertGt(gasUsed, 0, "Gas should be consumed");
        
        // Check contract has no leftover dust - should be clean after auto-withdraw
        uint256 wethDust = IERC20(WETH).balanceOf(address(liquidator));
        uint256 usdcDust = IERC20(USDC).balanceOf(address(liquidator));
        
        assertEq(wethDust, 0, "Should have no WETH dust");
        assertEq(usdcDust, 0, "Should have no USDC dust after auto-withdraw");
    }
    
    receive() external payable {}
}
