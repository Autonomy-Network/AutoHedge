pragma solidity 0.8.6;

// TODO License
// SPDX-License-Identifier: UNLICENSED

import "./DeltaNeutralStableVolatilePair.sol";
import "../interfaces/IDeltaNeutralFactory.sol";

contract DeltaNeutralStableVolatileFactory is IDeltaNeutralFactory {

//    address constant _ETH_ADDRESS_ = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE; TODO

    // Keep track of stablecoins so we can use a delta-neutral pool that only hedges the
    // other asset when paired with a known stablecoin
    mapping(address => bool) public stablecoins;
    mapping(address => mapping(address => address)) public override getPair;
    address[] private _allPairs;

    uint256 public constant override MAX_UINT = type(uint256).max;
    address public immutable override weth;
    address public immutable override uniV2Factory;
    address public immutable override uniV2Router;
    address public override comptroller;

    constructor(
        address weth_,
        address uniV2Factory_,
        address uniV2Router_,
        address comptroller_
    ) {
        weth = weth_;
        uniV2Factory = uniV2Factory_;
        uniV2Router = uniV2Router_;
        comptroller = comptroller_;
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

    function createPair(address tokenA, address tokenB) external override returns (address pair) {
        require(tokenA != tokenB, 'DNFac: addresses are the same');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'DNFac: zero address');
        require(getPair[token0][token1] == address(0), 'DNFac: pair exists'); // single check is sufficient

        // Create the pair
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        // TODO: just to get this to compile
        pair = address(new DeltaNeutralStableVolatilePair{salt: salt}(token0, token1, "Test", "TEST", payable(address(this)), address(this), 0, 0)); // TODO

        // Housekeeping
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        _allPairs.push(pair);
        emit PairCreated(token0, token1, pair, _allPairs.length);
    }

    // function setFeeTo(address _feeTo) external { TODO
    //     require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
    //     feeTo = _feeTo;
    // }

    // function setFeeToSetter(address _feeToSetter) external { TODO
    //     require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
    //     feeToSetter = _feeToSetter;
    // }
}
