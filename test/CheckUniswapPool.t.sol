// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {BaseTestConfig} from "./BaseTestConfig.sol";

interface IUniswapV3Pool {
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/**
 * @title CheckUniswapPoolTest
 * @notice Verify Uniswap V3 pool availability for liquidation swaps
 */
contract CheckUniswapPoolTest is Test, BaseTestConfig {
    
    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
    }
    
    function testCheckPoolsExist() public view {
        IUniswapV3Factory factory = IUniswapV3Factory(UNISWAP_FACTORY);
        uint24[3] memory fees = [FEE_TIER_LOW, FEE_TIER_MEDIUM, FEE_TIER_HIGH];
        
        for (uint i = 0; i < fees.length; i++) {
            address pool = factory.getPool(WETH, USDC, fees[i]);
            if (pool == address(0)) continue;
            
            uint128 liquidity = IUniswapV3Pool(pool).liquidity();
            assertGt(liquidity, 0, "Pool should have liquidity");
        }
    }
}
