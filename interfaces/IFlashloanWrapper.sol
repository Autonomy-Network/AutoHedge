pragma solidity 0.8.6;


interface IFlashloanWrapper {
    function takeOutFlashLoan(address token, uint amount) external returns (uint feeFactor);
    function repayFlashLoan(address token, uint amount) external;
    function getFeeFactor() external view returns (uint);
}