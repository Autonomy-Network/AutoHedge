// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.6;

import "@openzeppelin/contracts-upgradeable/utils/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "../external/compound/ICompoundPriceOracle.sol";
import "../external/compound/CToken.sol";
import "../external/compound/CErc20.sol";

import "./ICompoundBasePriceOracle.sol";

import "../../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../../contracts/DeltaNeutralStableVolatilePairUpgradeable.sol";

/**
 * @title AutoHedgeDummyOracle
 * @notice AutoHedgeDummyOracle is a price oracle for Uniswap (and SushiSwap) LP tokens.
 * @dev Implements the `ICompoundPriceOracle` interface used by Fuse pools (and Compound v2).
 */
contract AutoHedgeDummyOracle is ICompoundPriceOracle {
    using SafeMathUpgradeable for uint256;

    address public immutable weth;

    receive() external payable {}

    constructor(address _weth) {
        weth = _weth;
    }

    /**
     * @notice Get the LP token price price for an underlying token address.
     * @param underlying The underlying token address for which to get the price (set to zero address for ETH)
     * @return Price denominated in ETH (scaled by 1e18)
     */
    function price(address underlying) external returns (uint256) {
        return _price(underlying);
    }

    /**
     * @notice Returns the price in ETH of the token underlying `cToken`.
     * @dev Implements the `ICompoundPriceOracle` interface for Fuse pools (and Compound v2).
     * @return Price in ETH of the token underlying `cToken`, scaled by `10 ** (36 - underlyingDecimals)`.
     */
    function getUnderlyingPrice(CToken cToken)
        external
        override
        returns (uint256)
    {
        address underlying = CErc20(address(cToken)).underlying();
        // Comptroller needs prices to be scaled by 1e(36 - decimals)
        // Since `_price` returns prices scaled by 18 decimals, we must scale them by 1e(36 - 18 - decimals)
        return
            _price(underlying).mul(1e18).div(
                10**uint256(ERC20Upgradeable(underlying).decimals())
            );
    }

    /**
     * @dev Fetches the fair LP token/ETH price from Uniswap, with 18 decimals of precision.
     */
    function _price(address token) internal virtual returns (uint256) {
        return 10**17;
    }
}
