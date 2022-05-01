pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IUniswapV2Factory.sol";
import "./IUniswapV2Router02.sol";
import "./IComptroller.sol";


interface IDeltaNeutralStableVolatileFactory {
    event PairCreated(IERC20 indexed stable, IERC20 indexed vol, address pair, uint);

    function getPair(IERC20 stable, IERC20 vol) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);

    function createPair(IERC20 stable, IERC20 vol) external returns (address pair);

    // function setFeeTo(address) external; TODO
    // function setFeeToSetter(address) external; TODO

    function uniV2Factory() external view returns (IUniswapV2Factory);
    function uniV2Router() external view returns (IUniswapV2Router02);
//    function fuse() external view returns (address); TODO
    function registry() external view returns (address payable);
    function userFeeVeriForwarder() external view returns (address);
}
