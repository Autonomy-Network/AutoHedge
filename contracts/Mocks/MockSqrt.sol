pragma solidity 0.8.6;


import "../Maths.sol";


contract MockSqrt {
    function sqrt(uint num) public pure returns (uint) {
        return Maths.sqrt(num);
    }
}
