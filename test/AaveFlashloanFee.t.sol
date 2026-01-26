// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AaveFlashloanFeeTest
 * @notice Verify Aave V3 flashloan premium is 0.05% (5 basis points) on Base
 * @dev Tests single and multiple asset flashloans to confirm fee consistency
 */
contract AaveFlashloanFeeTest is Test, BaseTestConfig {
    IPool public pool;
    
    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        pool = IPool(POOL_ADDRESS);
    }
    
    function testAaveV3FlashloanFee() public {
        FlashloanReceiver receiver = new FlashloanReceiver();
        uint256 amount = 1000e6;
        
        deal(USDC, address(receiver), amount);
        vm.prank(address(receiver));
        IERC20(USDC).approve(POOL_ADDRESS, type(uint256).max);
        
        pool.flashLoanSimple(address(receiver), USDC, amount, "", 0);
        
        uint256 premium = receiver.premiumPaid();
        uint256 premiumBps = (premium * 10000) / amount;
        
        assertEq(premiumBps, FLASHLOAN_PREMIUM_BPS, "Expected 0.05% fee (5 bps)");
    }
    
    function testFlashloanFeeMultipleAssets() public {
        address[2] memory assets = [USDC, WETH];
        uint256[2] memory amounts = [uint256(1000e6), 1 ether];
        
        for (uint i = 0; i < assets.length; i++) {
            FlashloanReceiver receiver = new FlashloanReceiver();
            
            deal(assets[i], address(receiver), amounts[i] * 2);
            vm.prank(address(receiver));
            IERC20(assets[i]).approve(POOL_ADDRESS, type(uint256).max);
            
            pool.flashLoanSimple(address(receiver), assets[i], amounts[i], "", 0);
            
            uint256 premium = receiver.premiumPaid();
            uint256 premiumBps = (premium * 10000) / amounts[i];
            
            assertEq(premiumBps, FLASHLOAN_PREMIUM_BPS, "All assets should have 0.05% fee");
        }
    }
}

contract FlashloanReceiver {
    uint256 public premiumPaid;
    
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata
    ) external returns (bool) {
        premiumPaid = premium;
        IERC20(asset).approve(msg.sender, amount + premium);
        return true;
    }
}
