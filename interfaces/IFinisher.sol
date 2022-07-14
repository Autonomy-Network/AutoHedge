pragma solidity 0.8.6;


interface IFinisher {
    function onFlw(uint fee, bytes memory data) external;
}
