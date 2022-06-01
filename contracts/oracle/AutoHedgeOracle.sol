// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.6;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "../external/compound/PriceOracle.sol";
import "../external/compound/CToken.sol";
import "../external/compound/CErc20.sol";

import "../external/uniswap/IUniswapV2Pair.sol";

import "./BasePriceOracle.sol";

import "../../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../../contracts/DeltaNeutralStableVolatilePairUpgradeable.sol";

import "hardhat/console.sol";


/**
 * @title UniswapLpTokenPriceOracle
 * @author David Lucid <david@rari.capital> (https://github.com/davidlucid)
 * @notice UniswapLpTokenPriceOracle is a price oracle for Uniswap (and SushiSwap) LP tokens.
 * @dev Implements the `PriceOracle` interface used by Fuse pools (and Compound v2).
 */
contract AutoHedgeOracle is PriceOracle {

    address public immutable weth;

    constructor(address _weth) public {
        weth = _weth;
    }

    /**
     * @notice Get the LP token price price for an underlying token address.
     * @param underlying The underlying token address for which to get the price (set to zero address for ETH)
     * @return Price denominated in ETH (scaled by 1e18)
     */
    function price(address underlying) external returns (uint) {
        return _price(underlying);
    }

    /**
     * @notice Returns the price in ETH of the token underlying `cToken`.
     * @dev Implements the `PriceOracle` interface for Fuse pools (and Compound v2).
     * @return Price in ETH of the token underlying `cToken`, scaled by `10 ** (36 - underlyingDecimals)`.
     */
    function getUnderlyingPrice(CToken cToken) external override returns (uint) {
        address underlying = CErc20(address(cToken)).underlying();
        // Comptroller needs prices to be scaled by 1e(36 - decimals)
        // Since `_price` returns prices scaled by 18 decimals, we must scale them by 1e(36 - 18 - decimals)
        return _price(underlying) * (1e18) / (10 ** uint256(ERC20Upgradeable(underlying).decimals()));
    }

    /**
     * @dev Fetches the fair LP token/ETH price from Uniswap, with 18 decimals of precision.
     */
    function _price(address token) internal virtual returns (uint) {
        DeltaNeutralStableVolatilePairUpgradeable pair = DeltaNeutralStableVolatilePairUpgradeable(token);

        (IERC20Metadata stable,,IERC20Metadata volatile, ICErc20 cVol,IERC20Metadata uniLp, ICErc20 cUniLp) = pair.tokens();

        console.log("(A)");
        console.log(address(pair));
        console.log("!");
        console.log(cUniLp.balanceOfUnderlying(address(pair))); // ! This revert without a reason
        console.log("!");

        // get the prices of the volatile and the stable
        uint stablePriceInEth = address(stable) == weth ? 1e18 : BasePriceOracle(msg.sender).price(address(stable)) * (1e18) / (10 ** uint256(stable.decimals()));
        uint volatilePriceInEth = address(volatile) == weth ? 1e18 : BasePriceOracle(msg.sender).price(address(volatile)) * (1e18) / (10 ** uint256(volatile.decimals()));
        uint uniLpPriceInEth = address(uniLp) == weth ? 1e18 : BasePriceOracle(msg.sender).price(address(uniLp)) * (1e18) / (10 ** uint256(uniLp.decimals()));

        console.log("(B)");

        // convert that to the amounts of stable and volatile the pool owns
        // uint uniLpValueInEth = cUniLp.balanceOfUnderlying(token) * uniLpPriceInEth; // TODO check if it's this line or the one bellow
        uint uniLpValueInEth = cUniLp.balanceOfUnderlying(address(pair)) * uniLpPriceInEth; // TODO check if it's this line or the one above

        console.log("(C)");

        // get stables lent out
        uint stableLentOutValueInEth = cUniLp.balanceOfUnderlying(token) * stablePriceInEth;
        
        console.log("(D)");

        // get volatile owed
        uint volatileOwedValueInEth = cVol.borrowBalanceCurrent(address(this)) * volatilePriceInEth;
        
        console.log("(E)");

        uint totalValue = uniLpValueInEth + stableLentOutValueInEth - volatileOwedValueInEth;

        return totalValue;
    }
}
