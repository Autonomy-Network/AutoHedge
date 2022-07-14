pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./IBentoBox.sol";

interface IFlashloanWrapper {
    event Flashloan(
        address indexed receiver,
        IERC20 token,
        uint256 amount,
        uint256 fee,
        uint256 loanType
    );

    event FlashloanRepaid(address indexed to, uint256 amount);

    enum FlashloanType {
        Deposit,
        Withdraw
    }

    struct FinishRoute {
        address flwCaller;
        address target;
        FlashloanType flt;
    }

    function takeOutFlashLoan(
        IERC20 token,
        uint256 amount,
        bytes calldata data
    ) external;

    function getFeeFactor() external view returns (uint256);

    function sushiBentoBox() external view returns (IBentoBox);
}
