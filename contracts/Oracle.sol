pragma solidity 0.8.6;

// TODO License
// SPDX-License-Identifier: UNLICENSED

contract Oracle {
    function getUnderlyingPrice(address cToken) external view returns (uint) {
        return 3760000000000000000;
    }
}
