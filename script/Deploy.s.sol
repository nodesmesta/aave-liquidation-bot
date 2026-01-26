// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script} from "forge-std/Script.sol";
import {FlashloanLiquidator} from "../contracts/FlashloanLiquidator.sol";

contract DeployScript is Script {
    address constant POOL_ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant DATA_PROVIDER = 0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac;
    address constant UNISWAP_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    
    function run() external {
        vm.startBroadcast();
        FlashloanLiquidator liquidator = new FlashloanLiquidator(
            POOL_ADDRESSES_PROVIDER,
            UNIVERSAL_ROUTER,
            DATA_PROVIDER,
            UNISWAP_FACTORY,
            PERMIT2
        );
        vm.stopBroadcast();
    }
}
