pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./IBentoBox.sol";

interface IFlashloanWrapper {
    event FlashLoan(
        address indexed receiver,
        IERC20 token,
        uint256 amount,
        uint256 fee,
        uint256 loanType
    );

    event FlashLoanRepaid(address indexed to, uint256 amount);

    function takeOutFlashLoan(
        IERC20 token,
        uint256 amount,
        bytes calldata data
    ) external;

    function getFeeFactor() external view returns (uint256);

    function sushiBentoBox() external view returns (IBentoBox);

    function repayFlashLoan(IERC20 token, uint256 amount) external;
}
