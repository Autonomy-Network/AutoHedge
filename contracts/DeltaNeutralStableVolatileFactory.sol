pragma solidity 0.8.6;


import "./DeltaNeutralStableVolatilePair.sol";
import "../interfaces/IDeltaNeutralStableVolatileFactory.sol";
import "../interfaces/IERC20Symbol.sol";
import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV2Router02.sol";
import "../interfaces/IComptroller.sol";


contract DeltaNeutralStableVolatileFactory is IDeltaNeutralStableVolatileFactory {

//    address constant _ETH_ADDRESS_ = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE; TODO

    mapping(IERC20 => mapping(IERC20 => address)) public override getPair;
    address[] private _allPairs;

    IUniswapV2Factory public override uniV2Factory;
    IUniswapV2Router02 public override uniV2Router;
    IComptroller public comptroller;
    address payable public override registry;
    address public override userFeeVeriForwarder;
    DeltaNeutralStableVolatilePair.MmBps initMmBps;

    constructor(
        address weth_,
        IUniswapV2Factory uniV2Factory_,
        IUniswapV2Router02 uniV2Router_,
        IComptroller comptroller_,
        address payable registry_,
        address userFeeVeriForwarder_,
        DeltaNeutralStableVolatilePair.MmBps memory initMmBps_
    ) {
        uniV2Factory = uniV2Factory_;
        uniV2Router = uniV2Router_;
        comptroller = comptroller_;
        registry = registry_;
        userFeeVeriForwarder = userFeeVeriForwarder_;
        initMmBps = initMmBps_;
    }

    // function getPair(address tokenA, address tokenB) external override view returns (address) { TODO
    //     return getPair[tokenA][tokenB];
    // }

    function allPairs(uint index) external override view returns (address) {
        return _allPairs[index];
    }

    function allPairsLength() external override view returns (uint) {
        return _allPairs.length;
    }

    function createPair(IERC20 stable, IERC20 vol) external override returns (address pair) {
        require(stable != vol, 'DNFac: addresses are the same');
        require(stable != IERC20(address(0)), 'DNFac: zero address');
        require(vol != IERC20(address(0)), 'DNFac: zero address');
        require(getPair[stable][vol] == address(0), 'DNFac: pair exists'); // single check is sufficient

        // Create the pair
        bytes32 salt = keccak256(abi.encodePacked(stable, vol));
        // TODO: just to get this to compile
        string memory token0Symbol = IERC20Symbol(address(stable)).symbol();
        string memory token1Symbol = IERC20Symbol(address(vol)).symbol();
        pair = address(new DeltaNeutralStableVolatilePair{salt: salt}(
            uniV2Factory,
            uniV2Router,
            stable,
            vol,
            string(abi.encodePacked("AutoHedge-", token0Symbol, "-", token1Symbol)),
            string(abi.encodePacked("AUTOH-", token0Symbol, "-", token1Symbol)),
            registry,
            userFeeVeriForwarder,
            initMmBps,
            comptroller
        ));

        // Housekeeping
        getPair[stable][vol] = pair;
        _allPairs.push(pair);
        emit PairCreated(stable, vol, pair, _allPairs.length);
    }
}
