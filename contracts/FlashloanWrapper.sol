pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import "../interfaces/IFlashloanWrapper.sol";
import "../interfaces/IAutoHedgeLeveragedPosition.sol";

contract FlashloanWrapper is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IFlashloanWrapper,
    IFlashBorrower
{
    function initialize(address bentoBox_) external initializer {
        __Ownable_init_unchained();
        sushiBentoBox = IBentoBox(bentoBox_);
    }

    using SafeERC20 for IERC20;

    enum FlashLoanTypes {
        Deposit,
        Withdraw
    }

    IBentoBox public override sushiBentoBox;

    function takeOutFlashLoan(
        IERC20 token,
        uint256 amount,
        bytes calldata data
    ) external override {
        sushiBentoBox.flashLoan(
            IFlashBorrower(address(this)),
            msg.sender,
            token,
            amount,
            data
        );
    }

    function getFeeFactor() external view override returns (uint256) {
        return 0;
    }

    function onFlashLoan(
        address sender,
        IERC20 token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override {
        require(msg.sender == address(sushiBentoBox), "FLW: invalid caller");
        (FlashLoanTypes loanType, address ahLpContract) = abi.decode(
            data[:64],
            (FlashLoanTypes, address)
        );
        require(
            loanType == FlashLoanTypes.Deposit ||
                loanType == FlashLoanTypes.Withdraw,
            "FLW: invalid loan type"
        );
        require(ahLpContract != address(0), "FLW: invalid call data");

        if (loanType == FlashLoanTypes.Deposit) {
            IAutoHedgeLeveragedPosition(ahLpContract).initiateDeposit(
                amount,
                fee,
                data[64:]
            );
        } else {
            IAutoHedgeLeveragedPosition(ahLpContract).initiateWithdraw(
                amount,
                fee,
                data[64:]
            );
        }
    }

    function repayFlashLoan(IERC20 token, uint256 amount) external override {
        token.safeTransferFrom(msg.sender, address(sushiBentoBox), amount);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}