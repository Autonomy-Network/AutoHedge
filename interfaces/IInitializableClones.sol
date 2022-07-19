pragma solidity 0.8.6;

interface IInitializableClones {
    function clone(address master, bytes memory initializer)
        external
        returns (address instance);
}
