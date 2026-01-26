// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

contract MockAaveOracle {
    mapping(address => uint256) private assetPrices;
    
    function setAssetPrice(address asset, uint256 price) external {
        assetPrices[asset] = price;
    }
    
    function getAssetPrice(address asset) external view returns (uint256) {
        return assetPrices[asset];
    }
    
    function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory) {
        uint256[] memory prices = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            prices[i] = assetPrices[assets[i]];
        }
        return prices;
    }
}
