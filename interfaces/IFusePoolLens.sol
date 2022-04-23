pragma solidity 0.8.6;

pragma experimental ABIEncoderV2;

interface IFusePoolLens {

    struct FusePoolAsset {
        address cToken;
        address underlyingToken;
        string underlyingName;
        string underlyingSymbol;
        uint underlyingDecimals;
        uint underlyingBalance;
        uint supplyRatePerBlock;
        uint borrowRatePerBlock;
        uint totalSupply;
        uint totalBorrow;
        uint supplyBalance;
        uint borrowBalance;
        uint liquidity;
        bool membership;
        uint exchangeRate;
        uint underlyingPrice;
        address oracle;
        uint collateralFactor;
        uint reserveFactor;
        uint adminFee;
        uint fuseFee;
        bool borrowGuardianPaused;
    }

    function getPoolAssetsWithData(address comptroller) external view returns (FusePoolAsset[] memory);
}
