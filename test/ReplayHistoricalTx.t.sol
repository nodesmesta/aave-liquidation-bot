// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

contract ReplayHistoricalTxTest is Test, BaseTestConfig {
    address public constant LIQUIDATOR_DEPLOYED = 0x1eF26FE672e5Bd6af8D9f4B7519B7559626454F7;
    address public constant BOT_WALLET = 0x04898c077Eb5f6e3Dc5F6086Cd96CeeED523Cd81;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), 43712124);
    }

    function testReplayTx3b7c() public {
        console.log("Replaying exact calldata of TX 0x3b7c... at block 43712124:");
        
        bytes memory callData = hex"05c3786d000000000000000000000000cbb7c0000ab88b473b1f5afd9ef808440eed33bf000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000ddf9c3ef925a2a5fe61201b7f0ed73c6cb5fd07000000000000000000000000000000000000000000000000000000000cef415b";

        vm.prank(BOT_WALLET);
        (bool success, bytes memory returnData) = LIQUIDATOR_DEPLOYED.call(callData);
        
        console.log("Success:", success);
        if (!success) {
            console.log("Revert bytes length:", returnData.length);
            console.logBytes(returnData);
        }
    }
}
