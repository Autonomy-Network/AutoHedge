pragma solidity 0.8.6;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../../interfaces/autonomy/IForwarder.sol";

// TODO: use revertFailedCall in Shared
contract Forwarder is IForwarder, Ownable {
    mapping(address => bool) private _canCall;

    constructor() Ownable() {}

    function forward(address target, bytes calldata callData)
        external
        payable
        override
        returns (bool success, bytes memory returnData)
    {
        require(_canCall[msg.sender], "Forw: caller not the Registry");
        (success, returnData) = target.call{value: msg.value}(callData);
    }

    function canCall(address caller) external view returns (bool) {
        return _canCall[caller];
    }

    function setCaller(address caller, bool b) external override onlyOwner {
        _canCall[caller] = b;
    }
}
