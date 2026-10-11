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
    
    address constant OWNER = 0x04898c077Eb5f6e3Dc5F6086Cd96CeeED523Cd81;

    // Salt to produce vanity address with 6 leading zeros: 0x00000032fa2f481f41Db0c61a3eb5DDA86178E06
    bytes32 constant SALT = 0x6a511d341ec619ab0d83874926ecc3610dbd81d2b08d05f4b153fc59e2892d55;
    
    function run() external {
        vm.startBroadcast();
        FlashloanLiquidator liquidator = new FlashloanLiquidator{salt: SALT}(
            POOL_ADDRESSES_PROVIDER,
            UNIVERSAL_ROUTER,
            DATA_PROVIDER,
            UNISWAP_FACTORY,
            PERMIT2,
            OWNER
        );
        vm.stopBroadcast();
    }
}
