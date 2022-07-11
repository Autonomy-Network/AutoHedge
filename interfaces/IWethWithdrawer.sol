pragma solidity 0.8.6;

interface IWethWithdrawer {
  function withdraw(address payable receiver) external;
}
