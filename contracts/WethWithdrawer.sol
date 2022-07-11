pragma solidity 0.8.6;

import "../interfaces/IWETH.sol";

import "hardhat/console.sol";

contract WethWithdrawer {
  address public weth;

  constructor(address weth_) {
    weth = weth_;
  }

  function withdraw(address payable receiver) external {
    uint256 bal = IWETH(address(weth)).balanceOf(address(this));
    IWETH(address(weth)).withdraw(bal);
    (bool sent,) = receiver.call{value: bal}("");
    require(sent, "Failed to send Ether");
  }
}
