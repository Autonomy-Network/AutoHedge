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
 * @title AutoHedgeOracle
 * @notice AutoHedgeOracle is a price oracle for Uniswap (and SushiSwap) LP tokens.
 * @dev Implements the `ICompoundPriceOracle` interface used by Fuse pools (and Compound v2).
 */
contract AutoHedgeOracle is ICompoundPriceOracle {
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
        IDeltaNeutralStableVolatilePairUpgradeable pair = IDeltaNeutralStableVolatilePairUpgradeable(
                token
            );

        (
            IERC20Metadata stable,
            ,
            IERC20Metadata volatile,
            ICErc20 cVol,
            IERC20Metadata uniLp,
            ICErc20 cUniLp
        ) = pair.getTokens();

        // get the prices of the volatile and the stable
        uint256 stablePriceInEth = ICompoundBasePriceOracle(msg.sender).price(
            address(stable)
        );
        uint256 volatilePriceInEth = ICompoundBasePriceOracle(msg.sender).price(
            address(volatile)
        );

        uint256 uniLpPriceInEth = ICompoundBasePriceOracle(msg.sender).price(
            address(uniLp)
        );

        console.log("{}", cVol.accrueInterest());

        // convert that to the amounts of stable and volatile the pool owns
        uint256 uniLpValueInEth = cUniLp.balanceOfUnderlying(address(pair)) *
            uniLpPriceInEth;

        // get the amount of volatile owed
        uint256 stableAmountLentOut = cUniLp.balanceOfUnderlying(token);

        uint256 stableLentOutValueInEth = stableAmountLentOut *
            stablePriceInEth;

        // get the amount of stables lent out
        uint256 volatileAmountOwed = cVol.borrowBalanceCurrent(address(this));

        uint256 volatileOwedValueInEth = volatileAmountOwed *
            volatilePriceInEth;

        uint256 totalValue = uniLpValueInEth +
            stableLentOutValueInEth -
            volatileOwedValueInEth;

        return totalValue;
    }

    /**
     * @dev Fast square root function.
     * Implementation from: https://github.com/Uniswap/uniswap-lib/commit/99f3f28770640ba1bb1ff460ac7c5292fb8291a0
     * Original implementation: https://github.com/abdk-consulting/abdk-libraries-solidity/blob/master/ABDKMath64x64.sol#L687
     */
    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 xx = x;
        uint256 r = 1;

        if (xx >= 0x100000000000000000000000000000000) {
            xx >>= 128;
            r <<= 64;
        }
        if (xx >= 0x10000000000000000) {
            xx >>= 64;
            r <<= 32;
        }
        if (xx >= 0x100000000) {
            xx >>= 32;
            r <<= 16;
        }
        if (xx >= 0x10000) {
            xx >>= 16;
            r <<= 8;
        }
        if (xx >= 0x100) {
            xx >>= 8;
            r <<= 4;
        }
        if (xx >= 0x10) {
            xx >>= 4;
            r <<= 2;
        }
        if (xx >= 0x8) {
            r <<= 1;
        }

        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1; // Seven iterations should be enough
        uint256 r1 = x / r;
        return (r < r1 ? r : r1);
    }
}
