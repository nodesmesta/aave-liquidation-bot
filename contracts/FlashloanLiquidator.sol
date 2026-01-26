// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IPoolAddressesProvider} from '@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol';
import {IPool} from '@aave/core-v3/contracts/interfaces/IPool.sol';
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniversalRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function fee() external view returns (uint24);
}

interface IProtocolDataProvider {
    function getReserveTokensAddresses(address asset) 
        external 
        view 
        returns (
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress
        );
}

/**
 * @title FlashloanLiquidator
 * @notice Contract untuk liquidate posisi undercollateralized di Aave V3 menggunakan flashloan
 * @dev Extends dari pattern Aave flashloan receiver dengan Uniswap V3 swap integration
 */
contract FlashloanLiquidator {
    using SafeERC20 for IERC20;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    IUniversalRouter public immutable UNIVERSAL_ROUTER;
    IProtocolDataProvider public immutable DATA_PROVIDER;
    IUniswapV3Factory public immutable UNISWAP_FACTORY;
    address public immutable PERMIT2;
    address public owner;

    event LiquidationExecuted(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );
    event ProfitWithdrawn(address indexed token, uint256 amount, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }    
    
    /**
     * @notice Initialize contract with Aave and Uniswap addresses
     * @param _addressProvider Aave V3 PoolAddressesProvider address
     * @param _universalRouter Uniswap UniversalRouter address
     * @param _dataProvider Aave V3 ProtocolDataProvider address
     * @param _uniswapFactory Uniswap V3 Factory address
     * @param _permit2 Permit2 contract address
     */
    constructor(address _addressProvider, address _universalRouter, address _dataProvider, address _uniswapFactory, address _permit2) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        UNIVERSAL_ROUTER = IUniversalRouter(_universalRouter);
        DATA_PROVIDER = IProtocolDataProvider(_dataProvider);
        UNISWAP_FACTORY = IUniswapV3Factory(_uniswapFactory);
        PERMIT2 = _permit2;
        owner = msg.sender;
    }

    /**
     * @notice Execute liquidation of undercollateralized position
     * @dev Initiates flashloan which triggers liquidation flow through executeOperation callback
     * @param collateralAsset Address of collateral asset to seize
     * @param debtAsset Address of debt asset to repay
     * @param user Address of user to liquidate
     * @param debtToCover Amount of debt to cover 
     */
    function executeLiquidation(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover
    ) external onlyOwner {
        uint256 safeDebtAmount = calculateSafeDebtAmount(debtToCover);
        bytes memory params = abi.encode(collateralAsset, user);
        POOL.flashLoanSimple(address(this), debtAsset, safeDebtAmount, params, 0);
    }

    /**
     * @notice Aave flashloan callback function
     * @dev Executes liquidation, swaps collateral to debt asset, and repays flashloan
     * @param asset Address of flashloaned asset
     * @param amount Amount of flashloaned asset
     * @param premium Flashloan fee 
     * @param initiator Address that initiated the flashloan
     * @param params Encoded parameters (collateralAsset, user)
     * @return success Boolean indicating successful execution
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "Caller must be Pool");
        require(initiator == address(this), "Initiator must be this contract");
        (address collateralAsset, address user) = abi.decode(params, (address, address));
        SafeERC20.forceApprove(IERC20(asset), address(POOL), amount);
        POOL.liquidationCall(collateralAsset, asset, user, amount, false);
        uint256 collateralReceived = IERC20(collateralAsset).balanceOf(address(this));
        uint256 amountOwed = amount + premium;
        _swapCollateralToDebt(collateralAsset, asset, collateralReceived, amountOwed);
        SafeERC20.forceApprove(IERC20(asset), address(POOL), amountOwed);
        uint256 totalBalance = IERC20(asset).balanceOf(address(this));
        uint256 profit = totalBalance > amountOwed ? totalBalance - amountOwed : 0;
        if (profit > 0) {
            _withdrawProfit(asset, profit);
        }
        emit LiquidationExecuted(user, collateralAsset, asset, amount, collateralReceived, profit);
        return true;
    }

    /**
     * @notice Execute token swap via Uniswap UniversalRouter with specific fee tier
     * @dev External function to enable try-catch error handling in _swapCollateralToDebt
     * @param tokenIn Address of input token
     * @param tokenOut Address of output token
     * @param amountIn Amount of input token to swap
     * @param fee Uniswap V3 pool fee tier 
     * @param minAmountOut Minimum output amount for slippage protection
     * @return amountOut Actual amount of output token received
     */
    function attemptDirectSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        require(msg.sender == address(this), "Only self-call");
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        SafeERC20.forceApprove(IERC20(tokenIn), PERMIT2, type(uint256).max);
        (bool success,) = PERMIT2.call(
            abi.encodeWithSignature(
                "approve(address,address,uint160,uint48)",
                tokenIn,
                address(UNIVERSAL_ROUTER),
                type(uint160).max,
                type(uint48).max
            )
        );
        require(success, "Permit2 approval failed");
        bytes memory commands = abi.encodePacked(bytes1(0x00));
        bytes memory path = abi.encodePacked(tokenIn, fee, tokenOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(this), amountIn, minAmountOut, path, true);
        UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        amountOut = balanceAfter - balanceBefore;
        require(amountOut >= minAmountOut, "Insufficient output amount");
    }

    /**
     * @notice Internal function to automatically withdraw specific profit amount to owner
     * @dev Called from executeOperation to transfer only profit amount, leaving flashloan repayment
     * @param token Address of token to withdraw
     * @param amount Specific profit amount to withdraw
     */
    function _withdrawProfit(address token, uint256 amount) internal {
        require(amount > 0, "No profit to withdraw");
        SafeERC20.safeTransfer(IERC20(token), owner, amount);
        emit ProfitWithdrawn(token, amount, owner);
    }

    /**
     * @notice Transfer contract ownership to new address
     * @param newOwner Address of new owner
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid address");
        owner = newOwner;
    }

    /**
     * @notice Emergency function to approve tokens for specific spender
     * @dev Can be used to recover stuck tokens or fix approval issues
     * @param token Address of token to approve
     * @param spender Address to approve
     * @param amount Amount to approve
     */
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        SafeERC20.forceApprove(IERC20(token), spender, amount);
    }

    /**
     * @notice Calculate safe debt amount with 1% reduction for fees and buffer
     * @dev Reduces debt to account for flashloan fee (0.05%), swap fee (0.3%), and buffer (0.65%)
     * @param targetDebt Ideal debt amount to cover
     * @return safeDebt Adjusted debt amount ensuring profitability
     */
    function calculateSafeDebtAmount(uint256 targetDebt) public pure returns (uint256 safeDebt) {
        safeDebt = (targetDebt * 99) / 100;
    }

    /**
     * @notice Check if token is valid Aave V3 reserve
     * @dev Queries Protocol Data Provider to verify token is active reserve
     * @param token Address of token to check
     * @return isReserve True if token is active Aave reserve
     */
    function isAaveReserve(address token) public view returns (bool) {
        try DATA_PROVIDER.getReserveTokensAddresses(token) returns (
            address aTokenAddress,
            address,
            address
        ) {
            return aTokenAddress != address(0);
        } catch {
            return false;
        }
    }

    /**
     * @notice Swap collateral to debt asset using Uniswap V3 medium fee tier
     * @dev Uses 0.3% (3000 bps) fee tier which is Uniswap's standard default
     * @param fromToken Collateral token address
     * @param toToken Debt token address
     * @param amount Amount of collateral to swap
     * @param minAmountOut Minimum debt asset amount needed
     * @return amountOut Amount of debt asset received
     */
    function _swapCollateralToDebt(
        address fromToken,
        address toToken,
        uint256 amount,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        if (amount == 0) return 0;
        if (fromToken == toToken) return amount;
        uint24[3] memory possibleFees = [uint24(3000), uint24(500), uint24(10000)];
        for (uint256 i = 0; i < possibleFees.length; i++) {
            address poolAddress = UNISWAP_FACTORY.getPool(fromToken, toToken, possibleFees[i]);
            if (poolAddress != address(0)) {
                uint24 poolFee = IUniswapV3Pool(poolAddress).fee();
                return this.attemptDirectSwap(fromToken, toToken, amount, poolFee, minAmountOut);
            }
        }
        revert("No Uniswap pool found");
    }

    /**
     * @notice Receive ETH function
     * @dev Allows contract to receive ETH for UniversalRouter operations
     */
    receive() external payable {}
}
