// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {Vm} from "forge-std/Vm.sol";

library AaveOracleHelper {
    address constant AAVE_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    
    function mockPriceChange(
        Vm vm,
        address asset,
        uint256 newPrice
    ) internal {
        bytes32 slot = keccak256(abi.encode(asset, uint256(1)));
        vm.store(AAVE_ORACLE, slot, bytes32(newPrice));
    }
    
    function calculatePriceDrop(
        uint256 originalPrice,
        uint256 dropPercentage
    ) internal pure returns (uint256) {
        require(dropPercentage <= 100, "Drop percentage cannot exceed 100");
        return (originalPrice * (100 - dropPercentage)) / 100;
    }
    
    function simulateLiquidatablePosition(
        Vm vm,
        address asset,
        uint256 originalPrice,
        uint256 targetHealthFactor
    ) internal {
        uint256 priceDropPercentage = 100 - ((targetHealthFactor * 100) / 1e18);
        uint256 newPrice = calculatePriceDrop(originalPrice, priceDropPercentage);
        mockPriceChange(vm, asset, newPrice);
    }
}
