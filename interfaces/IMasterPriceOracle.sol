pragma solidity 0.8.6;

interface IMasterPriceOracle {
    function initialize(
        address[] memory underlyings,
        address[] memory _oracles,
        address _defaultOracle,
        address _admin,
        bool _canAdminOverwrite
    ) external;

    function add(address[] calldata underlyings, address[] calldata _oracles)
        external;
}
