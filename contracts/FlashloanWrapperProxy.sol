pragma solidity 0.8.6;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title FlashloanWrapperProxy Proxy Contract
/// @notice This contract serves as the UUPS proxy for upgrading and
///  initializing the Flash Loan Wrapper implementation contract.
contract FlashloanWrapperProxy is ERC1967Proxy {
    /// @notice Initializes the Flash Loan Wrapper via UUPS.
    /// @param logic The address of the Flash Loan Wrapper implementation.
    /// @param data ABI-encoded Flash Loan Wrapper initialization data.
    constructor(address logic, bytes memory data) ERC1967Proxy(logic, data) {}
}
