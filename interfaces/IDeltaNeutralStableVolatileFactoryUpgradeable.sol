pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./IUniswapV2Factory.sol";
import "./IUniswapV2Router02.sol";
import "./IComptroller.sol";
import "./IDeltaNeutralStableVolatilePairUpgradeable.sol";


interface IDeltaNeutralStableVolatileFactoryUpgradeable {
    event PairCreated(IERC20Metadata indexed stable, IERC20Metadata indexed vol, address pair, uint);
    event FeeReceiverSet(address indexed receiver);
    event DepositFeeSet(uint fee);

    function initialize(
        address beacon_,
        address weth_,
        IUniswapV2Factory uniV2Factory_,
        IUniswapV2Router02 uniV2Router_,
        IComptroller comptroller_,
        address payable registry_,
        address userFeeVeriForwarder_,
        IDeltaNeutralStableVolatilePairUpgradeable.MmBps memory initMmBps_,
        address feeReceiver_
    ) external;

    function getPair(IERC20Metadata stable, IERC20Metadata vol) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);

    function createPair(IERC20Metadata stable, IERC20Metadata vol) external returns (address pair);

    function setFeeReceiver(address newReceiver) external;
    function setDepositFee(uint newDepositFee) external;
    // function setFeeToSetter(address) external; TODO

    function uniV2Factory() external view returns (IUniswapV2Factory);
    function uniV2Router() external view returns (IUniswapV2Router02);
//    function fuse() external view returns (address); TODO
    function registry() external view returns (address payable);
    function userFeeVeriForwarder() external view returns (address);
    function feeReceiver() external view returns (address);
    function depositFee() external view returns (uint);
}
