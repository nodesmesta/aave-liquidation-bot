// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

/**
 * @title Permit2ApprovalTest
 * @notice Test Permit2 approval behavior for contract integration
 * @dev Validates void return value handling and approval mechanics
 */
contract Permit2ApprovalTest is Test, BaseTestConfig {
    
    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
    }

    function testPermit2ApproveReturnValue() public {
        deal(WETH, address(this), 1 ether);
        
        (bool success, bytes memory data) = PERMIT2.call(
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)",
                WETH,
                UNIVERSAL_ROUTER,
                type(uint160).max,
                type(uint48).max
            )
        );
        
        assertTrue(success, "Permit2 call should succeed");
        assertEq(data.length, 0, "Permit2 returns void (empty data)");
    }

    function testPermit2ApproveWithChecks() public {
        deal(WETH, address(this), 1 ether);
        
        (bool success, bytes memory data) = PERMIT2.call(
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)",
                WETH,
                UNIVERSAL_ROUTER,
                type(uint160).max,
                type(uint48).max
            )
        );
        
        assertTrue(success, "Basic success check");
        assertTrue(success && data.length == 0, "Success with void check");
        assertTrue(success && (data.length == 0 || abi.decode(data, (bool))), "Comprehensive check");
    }

    function testPermit2ApproveMultipleCalls() public {
        deal(WETH, address(this), 1 ether);
        
        for (uint256 i = 0; i < 3; i++) {
            (bool success, bytes memory data) = PERMIT2.call(
                abi.encodeWithSignature(
                    "approve(address,address,uint160,uint48)",
                    WETH,
                    UNIVERSAL_ROUTER,
                    type(uint160).max,
                    type(uint48).max
                )
            );
            
            assertTrue(success, "Multiple approvals should succeed");
            assertEq(data.length, 0, "All calls return void");
        }
    }

    function testPermit2AcceptsAnyTokenAddress() public {
        // Permit2 doesn't validate token at approval time (validation at transfer)
        (bool success,) = PERMIT2.call(
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)",
                address(0),
                UNIVERSAL_ROUTER,
                type(uint160).max,
                type(uint48).max
            )
        );
        
        assertTrue(success, "Permit2 accepts any token address");
    }
}
