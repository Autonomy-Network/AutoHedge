pragma solidity 0.8.6;

interface IFusePoolDirectory {
    struct FusePool {
        string name;
        address creator;
        address comptroller;
        uint256 blockPosted;
        uint256 timestampPosted;
    }

    function deployPool(
        string memory name,
        address implementation,
        bool enforceWhitelist,
        uint256 closeFactor,
        uint256 liquidationIncentive,
        address priceOracle
    ) external virtual returns (uint256, address);

    function getPoolsByAccount(address account)
        external
        view
        returns (uint256[] memory, FusePool[] memory);
}
