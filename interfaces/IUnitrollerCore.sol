pragma solidity 0.8.6;

interface IUnitrollerCore {
    function _acceptAdmin() external;

    function _deployMarket(
        bool isCEther,
        bytes calldata constructorData,
        uint256 collateralFactorMantissa
    ) external returns (uint256);
}
