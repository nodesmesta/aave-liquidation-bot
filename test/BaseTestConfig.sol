// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title BaseTestConfig
 * @notice Shared configuration and utilities for all liquidator tests
 * @dev Contains constants, structs, and helper functions used across test files
 */
contract BaseTestConfig {
    
    // Core Aave V3 Protocol Contracts (Base Mainnet)
    address constant POOL_ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address constant POOL_ADDRESS = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant DATA_PROVIDER = 0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac;
    address constant ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    
    // DEX Contracts (Base Mainnet)
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant UNISWAP_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    
    // Asset Addresses (Base Mainnet)
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    
    // Health Factor Thresholds (18 decimals)
    uint256 constant LIQUIDATABLE_THRESHOLD = 1.0e18;
    uint256 constant CRITICAL_THRESHOLD = 1.05e18;
    uint256 constant WARNING_THRESHOLD = 1.15e18;
    uint256 constant WATCH_THRESHOLD = 1.25e18;
    
    // Liquidation Parameters
    uint256 constant CLOSE_FACTOR_HF_THRESHOLD = 0.95e18;
    uint256 constant LIQUIDATION_BONUS_BASE = 10000;
    
    // Uniswap V3 Fee Tiers (basis points)
    uint24 constant FEE_TIER_LOW = 500;      // 0.05%
    uint24 constant FEE_TIER_MEDIUM = 3000;  // 0.30%
    uint24 constant FEE_TIER_HIGH = 10000;   // 1.00%
    
    // Flashloan Parameters
    uint256 constant FLASHLOAN_PREMIUM_BPS = 5; // 0.05%
    uint256 constant MIN_PROFIT_USD = 10;
    
    // Bitmap Decoding Constants
    uint256 constant MAX_RESERVES = 128;
    uint256 constant BITS_PER_RESERVE = 2;
    
    struct RealLiquidationCase {
        uint256 blockNumber;
        address user;
        address collateralAsset;
        address debtAsset;
        uint256 debtAmount;
        bytes32 txHash;
    }
    
    function getLiquidationCase1() internal pure returns (RealLiquidationCase memory) {
        return RealLiquidationCase({
            blockNumber: 41186135,
            user: 0x9a08624B5D57c00FDa407de2dea43450B9A0a243,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtAmount: 1176617618,
            txHash: 0x8f980420855c51a75769bea26dbc4bffe646727e6f5f002f2bae4db60dc0cfeb
        });
    }
    
    function getLiquidationCase2() internal pure returns (RealLiquidationCase memory) {
        return RealLiquidationCase({
            blockNumber: 0, // Use latest block
            user: 0x1f9114762Ad947dDa85dc39733bA966D4B6D9d87,
            collateralAsset: USDC,
            debtAsset: USDBC,
            debtAmount: 155138180, // Full debt amount
            txHash: bytes32(0) // Not executed yet
        });
    }
    
    function calculateCloseFactor(uint256 healthFactor) internal pure returns (uint256) {
        return healthFactor > CLOSE_FACTOR_HF_THRESHOLD ? 5000 : 10000;
    }
    
    function calculateDebtToCover(uint256 totalDebt, uint256 healthFactor) internal pure returns (uint256) {
        uint256 closeFactor = calculateCloseFactor(healthFactor);
        return (totalDebt * closeFactor) / 10000;
    }
    
    function calculateLiquidationBonus(uint256 liquidationBonusRaw) internal pure returns (uint256) {
        return (liquidationBonusRaw - LIQUIDATION_BONUS_BASE) / 100;
    }
    
    function calculateFlashloanFee(uint256 amount) internal pure returns (uint256) {
        return (amount * FLASHLOAN_PREMIUM_BPS) / 10000;
    }
    
    function isLiquidatable(uint256 healthFactor) internal pure returns (bool) {
        return healthFactor < LIQUIDATABLE_THRESHOLD;
    }
}
