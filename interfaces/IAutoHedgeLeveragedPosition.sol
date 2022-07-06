pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../interfaces/ICErc20.sol";
import "../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../interfaces/IFlashloanWrapper.sol";
import "../interfaces/IAutoHedgeLeveragedPositionFactory.sol";

interface IAutoHedgeLeveragedPosition {
    struct TokensLev {
        IERC20Metadata stable;
        ICErc20 cStable;
        IERC20Metadata vol;
        ICErc20 cVol;
        IERC20Metadata uniLp;
        ICErc20 cUniLp;
        IDeltaNeutralStableVolatilePairUpgradeable pair;
        ICErc20 cAhlp;
    }

    event DepositLev(
        address indexed comptroller,
        address indexed pair,
        uint256 amountStableDeposit,
        uint256 amountStableFlashloan,
        uint256 leverageRatio
    );

    function initialize(IAutoHedgeLeveragedPositionFactory factory_) external;

    function initiateDeposit(
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external;

    function initiateWithdraw(
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external;
}
