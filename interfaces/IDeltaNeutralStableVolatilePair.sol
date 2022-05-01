pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/IERC20.sol";


interface IDeltaNeutralStableVolatilePair {

    struct Amounts {
        uint stable;
        uint vol;
    }

    struct UniArgs {
        uint amountStableMin;
        uint amountVolMin;
        uint deadline;
        address[] swapPath;
        uint swapAmountOutMin;
    }

    struct MmBps {
        uint16 min;
        uint16 max;
    }

    function deposit(
        uint amountStableDesired,
        uint amountVolDesired,
        UniArgs calldata uniArgs,
        address to
    ) external payable;

    function withdraw(
        uint liquidity,
        UniArgs calldata uniArgs
    ) external;

    function rebalanceAuto(
        address user,
        uint feeAmount,
        uint maxGasPrice
    ) external;

    function getDebtBps() external returns (uint ownedAmountVol, uint debtAmountVol, uint debtBps);

    function setMmBps(MmBps calldata newMmBps) external;
}
