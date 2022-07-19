// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.6;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "../interfaces/IInitializableClones.sol";
import "../interfaces/IFusePoolDirectory.sol";
import "../interfaces/IMasterPriceOracle.sol";
import "../interfaces/IUnitrollerCore.sol";

import "../contracts/autonomy/Forwarder.sol";
import "../contracts/autonomy/Oracle.sol";
import "../contracts/autonomy/PriceOracle.sol";
import "../contracts/autonomy/Registry.sol";
import "../contracts/autonomy/StakeManager.sol";

import "../contracts/oracle/AutoHedgeOracle.sol";
import "../contracts/DeltaNeutralStableVolatileFactoryUpgradeable.sol";
import "../contracts/DeltaNeutralStableVolatilePairUpgradeable.sol";
import "../contracts/TProxy.sol";
import "../contracts/TProxyAdmin.sol";
import "../contracts/UBeacon.sol";

contract AutoHedgeOracleTest is Test {
    address constant INITIALIZABLE_CLONES_ADDRESS =
        0x91cE5566DC3170898C5aeE4ae4dD314654B47415;
    address constant MASTER_PRICE_ORACLE_ADDRESS =
        0xb3c8eE7309BE658c186F986388c2377da436D8fb;
    address constant DEFAULT_PRICE_ORACLE_ADDRESS =
        0x1887118E49e0F4A78Bd71B792a49dE03504A764D;
    address constant FUSE_POOL_DIRECTORY_ADDRESS =
        0x835482FE0532f169024d5E9410199369aAD5C77E;
    address constant COMPTROLLER_IMPL_ADDRESS =
        0xE16DB319d9dA7Ce40b666DD2E365a4b8B3C18217;
    address constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant UNIV2_DAI_ETH_ADDRESS =
        0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11;
    address constant UNIV2_FACTORY_ADDRESS =
        0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address constant UNIV2_ROUTER_ADDRESS =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant JUMP_RATE_MODEL_ADDRESS =
        0xbAB47e4B692195BF064923178A90Ef999A15f819;
    address constant JUMP_RATE_MODEL_UNI_ADDRESS =
        0xc35DB333EF7ce4F246DE9DE11Cc1929d6AA11672;
    address constant CERC20_IMPLEMENTATION_ADDRESS =
        0x67Db14E73C2Dce786B5bbBfa4D010dEab4BBFCF9;

    address masterPriceOracle;
    IFusePoolDirectory fuse;
    IUnitrollerCore unitroller;
    IForwarder uf;
    IForwarder ff;
    IForwarder uff;
    IRegistry reg;
    address owner;
    address factory;
    address pair;

    function setUp() public {
        owner = msg.sender;

        // Deploy Oracle
        bytes memory data = abi.encodeWithSelector(
            IMasterPriceOracle.initialize.selector,
            new address[](0),
            new address[](0),
            DEFAULT_PRICE_ORACLE_ADDRESS,
            owner,
            true
        );
        masterPriceOracle = IInitializableClones(INITIALIZABLE_CLONES_ADDRESS)
            .clone(MASTER_PRICE_ORACLE_ADDRESS, data);
        fuse = IFusePoolDirectory(FUSE_POOL_DIRECTORY_ADDRESS);

        // Deploy Pools
        uint256 closeFactor = 5 * (10**17);
        uint256 liquidationIncentive = 108 * (10**16);

        vm.startPrank(owner);

        fuse.deployPool(
            "Test0",
            COMPTROLLER_IMPL_ADDRESS,
            false,
            closeFactor,
            liquidationIncentive,
            masterPriceOracle
        );
        (, IFusePoolDirectory.FusePool[] memory pools) = fuse.getPoolsByAccount(
            msg.sender
        );
        assertEq(pools.length, 1);

        address[] memory underlyings = new address[](1);
        underlyings[0] = UNIV2_DAI_ETH_ADDRESS;
        address[] memory _oracles = new address[](1);
        _oracles[0] = 0x50F42c004Bd9B0E5ACc65c33Da133FBFbE86c7C0;

        IMasterPriceOracle(masterPriceOracle).add(underlyings, _oracles);

        // Deploy Autonomy
        IPriceOracle po = new PriceOracle(2000 ether, 5 * (10**9));
        IOracle o = new Oracle(po, false);
        IStakeManager sm = new StakeManager(o);
        uf = new Forwarder();
        ff = new Forwarder();
        uff = new Forwarder();
        reg = IRegistry(
            new Registry(
                sm,
                o,
                uf,
                ff,
                uff,
                "Autonomy Network",
                "AUTO",
                1000000000 ether
            )
        );

        sm.setAUTO(IERC777(reg.getAUTOAddr()));
        uf.setCaller(address(reg), true);
        ff.setCaller(address(reg), true);
        uff.setCaller(address(reg), true);

        // Deploy markets
        unitroller = IUnitrollerCore(pools[0].comptroller);
        unitroller._acceptAdmin();

        uint256 reserveFactor = 10**17;
        uint256 collateralFactorMantissa = 7 * (10**17);
        unitroller._deployMarket(
            false,
            abi.encode(
                UNIV2_DAI_ETH_ADDRESS,
                address(unitroller),
                JUMP_RATE_MODEL_UNI_ADDRESS,
                "UniV2 DAI ETH LP",
                "fUNI-DAI-ETH-185",
                CERC20_IMPLEMENTATION_ADDRESS,
                "",
                reserveFactor,
                0
            ),
            collateralFactorMantissa
        );
        unitroller._deployMarket(
            false,
            abi.encode(
                DAI_ADDRESS,
                address(unitroller),
                JUMP_RATE_MODEL_ADDRESS,
                "Test0 DAI",
                "fDAI-185",
                CERC20_IMPLEMENTATION_ADDRESS,
                "",
                reserveFactor,
                0
            ),
            collateralFactorMantissa
        );
        unitroller._deployMarket(
            false,
            abi.encode(
                WETH_ADDRESS,
                address(unitroller),
                JUMP_RATE_MODEL_ADDRESS,
                "Test0 WETH",
                "fWETH-185",
                CERC20_IMPLEMENTATION_ADDRESS,
                "",
                reserveFactor,
                0
            ),
            collateralFactorMantissa
        );

        // Deploy AHLP
        address pairImpl = address(
            new DeltaNeutralStableVolatilePairUpgradeable()
        );
        address factoryImpl = address(
            new DeltaNeutralStableVolatileFactoryUpgradeable()
        );
        address beacon = address(new UBeacon(pairImpl));
        address proxyAdmin = address(new TProxyAdmin());

        IDeltaNeutralStableVolatilePairUpgradeable.MmBps
            memory bps = IDeltaNeutralStableVolatilePairUpgradeable.MmBps(
                99 * (10**16),
                101 * (10**16)
            );

        bytes memory factoryData = abi.encodeWithSelector(
            IDeltaNeutralStableVolatileFactoryUpgradeable.initialize.selector,
            beacon,
            WETH_ADDRESS,
            UNIV2_FACTORY_ADDRESS,
            UNIV2_ROUTER_ADDRESS,
            address(unitroller),
            address(reg),
            address(uff),
            bps,
            address(0)
        );
        factory = address(new TProxy(factoryImpl, proxyAdmin, factoryData));

        pair = IDeltaNeutralStableVolatileFactoryUpgradeable(factory)
            .createPair(
                IERC20Metadata(DAI_ADDRESS),
                IERC20Metadata(WETH_ADDRESS)
            );

        // Deploy AHLP Oracle
        deployAHLPOracle();

        unitroller._deployMarket(
            false,
            abi.encode(
                pair,
                address(unitroller),
                JUMP_RATE_MODEL_UNI_ADDRESS,
                "DAI WETH AHLP",
                "fAH-DAI-WETH-185",
                CERC20_IMPLEMENTATION_ADDRESS,
                "",
                reserveFactor,
                0
            ),
            collateralFactorMantissa
        );

        vm.stopPrank();
    }

    function deployAHLPOracle() private {
        address ahOracle = address(new AutoHedgeOracle(WETH_ADDRESS));

        address[] memory underlyings = new address[](1);
        underlyings[0] = pair;
        address[] memory _oracles = new address[](1);
        _oracles[0] = ahOracle;

        IMasterPriceOracle(masterPriceOracle).add(underlyings, _oracles);
    }

    function testOracle() public {}
}
