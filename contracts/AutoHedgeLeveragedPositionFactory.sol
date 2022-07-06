pragma solidity 0.8.6;

import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import "../interfaces/IAutoHedgeLeveragedPosition.sol";
import "../interfaces/IAutoHedgeLeveragedPositionFactory.sol";

contract AutoHedgeLeveragedPositionFactory is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IAutoHedgeLeveragedPositionFactory
{
    function initialize(address beacon_, IFlashloanWrapper flw_)
        public
        initializer
    {
        __Ownable_init_unchained();
        beacon = beacon_;
        flw = flw_;
    }

    IFlashloanWrapper public override flw;
    address public beacon;
    mapping(address => address) public leveragedPositions;

    function createLeveragedPosition()
        external
        override
        returns (address lvgPos)
    {
        require(
            leveragedPositions[msg.sender] == address(0),
            "AHLPFac: already have leveraged position"
        );

        bytes32 salt = keccak256(abi.encodePacked(msg.sender));
        bytes memory data = abi.encodeWithSelector(
            IAutoHedgeLeveragedPosition.initialize.selector,
            address(this)
        );
        lvgPos = address(new BeaconProxy{salt: salt}(beacon, data));
        leveragedPositions[msg.sender] = lvgPos;
        OwnableUpgradeable(lvgPos).transferOwnership(msg.sender);

        emit LeveragedPositionCreated(msg.sender, lvgPos);
    }

    function setFlashloanWrapper(IFlashloanWrapper flw_) external onlyOwner {
        require(
            address(flw_) != address(0),
            "AHLPFac: invalid flashloan wrapper"
        );
        flw = flw_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
