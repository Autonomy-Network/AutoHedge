pragma solidity 0.8.6;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import "../interfaces/IDeltaNeutralStableVolatileFactoryUpgradeable.sol";
import "../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../interfaces/IERC20Symbol.sol";
import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV2Router02.sol";
import "../interfaces/IComptroller.sol";

import "hardhat/console.sol";


contract DeltaNeutralStableVolatileFactoryUpgradeable is IDeltaNeutralStableVolatileFactoryUpgradeable, Initializable, OwnableUpgradeable {

    mapping(IERC20Metadata => mapping(IERC20Metadata => address)) public override getPair;
    address[] private _allPairs;

    address public beacon;
    address public weth;
    IUniswapV2Factory public override uniV2Factory;
    IUniswapV2Router02 public override uniV2Router;
    IComptroller public comptroller;
    address payable public override registry;
    address public override userFeeVeriForwarder;
    IDeltaNeutralStableVolatilePairUpgradeable.MmBps initMmBps;
    address public override feeReceiver;
    uint public override depositFee;

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
    ) public override initializer {
        __Ownable_init_unchained();

        beacon = beacon_;
        weth = weth_;
        uniV2Factory = uniV2Factory_;
        uniV2Router = uniV2Router_;
        comptroller = comptroller_;
        registry = registry_;
        userFeeVeriForwarder = userFeeVeriForwarder_;
        initMmBps = initMmBps_;
        feeReceiver = feeReceiver_;
        // initial deposit fee is 0.3%
        depositFee = 3e15;

        emit FeeReceiverSet(feeReceiver);
        emit DepositFeeSet(depositFee);
    }

    function allPairs(uint index) external override view returns (address) {
        return _allPairs[index];
    }

    function allPairsLength() external override view returns (uint) {
        return _allPairs.length;
    }

    function createPair(IERC20Metadata stable, IERC20Metadata vol) external override returns (address pair) {
        require(stable != vol, 'DNFac: addresses are the same');
        require(stable != IERC20Metadata(address(0)), 'DNFac: zero address');
        require(vol != IERC20Metadata(address(0)), 'DNFac: zero address');
        require(getPair[stable][vol] == address(0), 'DNFac: pair exists'); // single check is sufficient

        // Create the pair
        bytes32 salt = keccak256(abi.encodePacked(stable, vol));
        string memory token0Symbol = IERC20Symbol(address(stable)).symbol();
        string memory token1Symbol = IERC20Symbol(address(vol)).symbol();

        IComptroller _comptroller = comptroller; // Gas savings
        address uniLp = uniV2Factory.getPair(address(stable), address(vol));
        IDeltaNeutralStableVolatilePairUpgradeable.Tokens memory tokens = IDeltaNeutralStableVolatilePairUpgradeable.Tokens(
            stable,
            ICErc20(_comptroller.cTokensByUnderlying(address(stable))),
            vol,
            ICErc20(_comptroller.cTokensByUnderlying(address(vol))),
            IERC20Metadata(uniLp),
            ICErc20(_comptroller.cTokensByUnderlying(address(uniLp)))
        );

        bytes memory data = abi.encodeWithSelector(
            IDeltaNeutralStableVolatilePairUpgradeable.initialize.selector,
            uniV2Router,
            tokens,
            weth,
            string(abi.encodePacked("AutoHedge-", token0Symbol, "-", token1Symbol)),
            string(abi.encodePacked("AH-", token0Symbol, "-", token1Symbol)),
            registry,
            userFeeVeriForwarder,
            initMmBps,
            comptroller,
            address(this)
        );
        console.logBytes(data); // Need to know the inputs to the constructor to verify the source code
        pair = address(new BeaconProxy{salt: salt}(beacon, data));
        OwnableUpgradeable(pair).transferOwnership(owner());
        // Housekeeping
        // Don't want to save the reverse ordering because we don't want to sort the
        // tokens. The tokens need to be inputed into `createPair` in the correct
        // order and the contract has no way of knowing which token is a stable or
        // volatile token, and we don't want someone to maliciously create new pairs
        // with them the wrong way round and therefore prevent them being created correctly
        // in the future if each pair is saved in both orders in `getPair`
        getPair[stable][vol] = pair;
        _allPairs.push(pair);
        emit PairCreated(stable, vol, pair, _allPairs.length);
    }

    function setFeeReceiver(address newReceiver) external override onlyOwner {
        require(newReceiver != address(0), "DNFac: zero address");
        feeReceiver = newReceiver;
        emit FeeReceiverSet(feeReceiver);
    }

    function setDepositFee(uint newDepositFee) external override onlyOwner {
        require(newDepositFee > 0 && newDepositFee < 1 ether, "DNFac: invalid deposit fee");
        depositFee = newDepositFee;
        emit DepositFeeSet(depositFee);
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[50] private __gap;
}
