pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/ICErc20.sol";
import "../interfaces/IUniswapV2Router02.sol";


interface IShared {
    struct ReserveParams {
        IERC20 stable;
        IERC20 vol;
        IERC20 uniLp;
        ICErc20 cStable;
        ICErc20 cVol;
        ICErc20 cUniLp;
        uint amountStable;
        uint amountVol;
        uint amountUniLp;
        IUniswapV2Router02 uniV2Router;
    }
}