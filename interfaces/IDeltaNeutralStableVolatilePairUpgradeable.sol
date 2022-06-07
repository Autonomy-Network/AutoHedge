pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./IUniswapV2Factory.sol";
import "./IUniswapV2Router02.sol";
import "./IComptroller.sol";
import "./ICErc20.sol";
import "./autonomy/IRegistry.sol";


interface IDeltaNeutralStableVolatilePairUpgradeable {

    struct Amounts {
        uint stable;
        uint vol;
    }

    struct UniArgs {
        uint amountStableMin;
        uint amountVolMin;
        uint deadline;
        address[] pathStableToVol;
        address[] pathVolToStable;
        uint swapAmountOutMin;
    }

    struct MmBps {
        uint64 min;
        uint64 max;
    }

    struct VolPosition {
        uint owned;
        uint debt;
        uint bps;
    }

    struct Tokens {
        IERC20Metadata stable;
        ICErc20 cStable;
        IERC20Metadata vol;
        ICErc20 cVol;
        IERC20Metadata uniLp;
        ICErc20 cUniLp;
    }

    event Deposited(address indexed user, uint amountStable, uint amountVol, uint amountUniLp, uint amountStableSwap, uint amountMinted);
    event Withdrawn(address indexed user, uint amountStableFromLending, uint amountVolToRepay, uint amountBurned);

    function initialize(
        IUniswapV2Router02 uniV2Router_,
        Tokens memory tokens,
        IERC20Metadata weth_,
        string memory name_,
        string memory symbol_,
        IRegistry registry_,
        address userFeeVeriForwarder_,
        MmBps memory mmBps_,
        IComptroller _comptroller
    ) external;
    
    function deposit(
        uint amountStableDesired,
        uint amountVolDesired,
        UniArgs calldata uniArgs,
        address to,
        address referrer
    ) external returns (uint amountStable, uint amountVol, uint amountUniLp);

    function withdraw(
        uint liquidity,
        UniArgs calldata uniArgs
    ) external returns (uint amountStableToUser);

    function rebalanceAuto(
        address user,
        uint feeAmount
    ) external;

    function getDebtBps() external returns (VolPosition memory);

    function setMmBps(MmBps calldata newMmBps) external;

    function getTokens() external view returns (
        IERC20Metadata stable,
        ICErc20 cStable,
        IERC20Metadata vol,
        ICErc20 cVol,
        IERC20Metadata uniLp,
        ICErc20 cUniLp
    );
}
