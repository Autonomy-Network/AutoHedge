pragma solidity 0.8.6;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "../interfaces/IComptroller.sol";
import "../interfaces/IAutoHedgeLeveragedPosition.sol";

import "hardhat/console.sol";

contract AutoHedgeLeveragedPosition is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IAutoHedgeLeveragedPosition
{
    function initialize(IAutoHedgeLeveragedPositionFactory factory_)
        external
        override
        initializer
    {
        __Ownable_init_unchained();
        factory = factory_;
        // TODO: add call to depositLev so they can create the contract
        // and open a position in 1 tx
    }

    using SafeERC20 for IERC20Metadata;

    uint256 private constant BASE_FACTOR = 1e18;
    uint256 private constant MAX_UINT = type(uint256).max;

    IAutoHedgeLeveragedPositionFactory public factory;

    /**
     * @param amountStableDeposit   The amount of stables taken from the user
     * @param amountStableFlashloan The amount of stables to borrow from a flashloan which
     *      is used to deposit (along with `amountStableDeposit`) to AH. Since there
     *      is a fee for taking out a flashloan and depositing to AH, that's paid by
     *      borrowing more stables, which therefore increases the leverage ratio. In
     *      order to compensate for this, we need to have a reduced flashloan which
     *      therefore lowers the total position size. Given `amountStableDeposit` and
     *      the desired leverage ratio, we can calculate `amountStableFlashloan`
     *      with these linear equations:
     *          The flashloan fee is a % of the loan
     *          (a) amountFlashloanFee = amountStableFlashloan*flashloanFeeRate
     *
     *          The value of the AH LP tokens after depositing is the total amount deposited,
     *          which is the initial collateral and the amount from the flashloan, multiplied by
     *          the amount that is kept after fees/costs
     *          (b) amountStableAhlp = (amountStableDeposit + amountStableFlashloan)*ahConvRate
     *
     *          The amount being borrowed from Fuse needs to be enough to pay back the flashloan
     *          and its fee
     *          (c) amountStableBorrowed = amountStableFlashloan + amountFlashloanFee
     *
     *          The leverage ratio is the position size div by the 'collateral', i.e. how
     *          much the user would be left with after withdrawing everything.
     *          TODO: 'collateral' currently doesn't account for the flashloan fee when withdrawing
     *          (d) leverage = amountStableAhlp / (amountStableAhlp - amountStableBorrowed)
     *
     *      Subbing (a) into (c):
     *          (e) amountStableBorrowed = amountStableFlashloan + amountStableFlashloan*flashloanFeeRate
     *          (f) amountStableBorrowed = amountStableFlashloan*(1 + flashloanFeeRate)
     *          (g) amountStableFlashloan = amountStableBorrowed/(1 + flashloanFeeRate)
     *
     *      Rearranging (d):
     *          (h) amountStableAhlp - amountStableBorrowed = amountStableAhlp/leverage
     *          (i) amountStableBorrowed = amountStableAhlp*(1 - (1/leverage))
     *
     *      Subbing (i) into (g):
     *          (j) amountStableFlashloan = (amountStableAhlp * (1 - (1/leverage))) / (1 + flashloanFeeRate)
     *
     *      Subbing (b) into (j):
     *          (k) amountStableFlashloan = (((amountStableDeposit + amountStableFlashloan)*ahConvRate) * (1 - (1/leverage))) / (1 + flashloanFeeRate)
     *      Rearranging, the general formula for `amountStableFlashloan` is:
     *          (l) amountStableFlashloan = -(amountStableDeposit * ahConvRate * (leverage - 1)) / (ahConvRate * (leverage - 1) - leverage * (flashloanFeeRate + 1))
     *
     *      E.g. if amountStableDeposit = 10, ahConvRate = 0.991, leverage = 5, flashloanFeeRate = 0.0005
     *          amountStableFlashloan = -(10 * 0.991 * (5 - 1)) / (0.991 * (5 - 1) - 5 * (0.0005 + 1))
     *          amountStableFlashloan = 37.71646...
     * @param leverageRatio The leverage ratio scaled to 1e18. Used to check that the leverage
     *      is what is intended at the end of the fcn. E.g. if wanting 5x leverage, this should
     *      be 5e18.
     */
    function depositLev(
        IComptroller comptroller,
        TokensLev memory tokens,
        uint256 amountVolZapMin,
        IDeltaNeutralStableVolatilePairUpgradeable.UniArgs calldata uniArgs,
        address referrer,
        uint256 amountStableDeposit,
        uint256 amountStableFlashloan,
        uint256 leverageRatio
    ) external onlyOwner nonReentrant {
        require(amountStableFlashloan > 0, "AHLevPos: total less than init");

        // Enter the relevant markets on Fuse/Midas
        address[] memory cTokens = new address[](2);
        cTokens[0] = address(tokens.cStable);
        cTokens[1] = address(tokens.cAhlp);
        uint256[] memory results = comptroller.enterMarkets(cTokens);
        require(
            results[0] == 0 && results[1] == 0,
            string(
                abi.encodePacked(
                    "AHLevPos: cant enter markets: ",
                    Strings.toString(results[0]),
                    " ",
                    Strings.toString(results[1])
                )
            )
        );

        transferApproveUnapproved(
            address(tokens.pair),
            tokens.stable,
            amountStableDeposit
        );

        // Take out a flashloan for the amount that needs to be borrowed
        bytes memory loanData = abi.encode(
            0,
            address(this),
            tokens,
            amountVolZapMin,
            uniArgs,
            referrer,
            amountStableDeposit
        );
        IFlashloanWrapper flw = factory.flw();
        flw.takeOutFlashLoan(tokens.stable, amountStableFlashloan, loanData);

        // TODO: Some checks requiring that the positions are what they should be everywhere
        // TODO: Check that the collat ratio is above some value
        // TODO: Do these checks on withdrawLev too
        emit DepositLev(
            address(comptroller),
            address(tokens.pair),
            amountStableDeposit,
            amountStableFlashloan,
            leverageRatio
        );
    }

    function initiateDeposit(
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override {
        // TODO add modifier for only flash loan wrapper
        (
            uint256 loanType,
            address lvgPos,
            TokensLev memory tokens,
            uint256 amountVolZapMin,
            IDeltaNeutralStableVolatilePairUpgradeable.UniArgs memory uniArgs,
            address referrer,
            uint256 amountStableDeposit
        ) = abi.decode(
                data,
                (
                    uint256,
                    address,
                    TokensLev,
                    uint256,
                    IDeltaNeutralStableVolatilePairUpgradeable.UniArgs,
                    address,
                    uint256
                )
            );

        // Deposit all stables (except for the flashloan fee) from the user and flashloan to AH
        tokens.pair.deposit(
            amountStableDeposit + amount,
            amountVolZapMin,
            uniArgs,
            address(this),
            referrer
        );

        // Put all AHLP tokens as collateral
        // TODO: call approve on cAhlp
        uint256 ahlpBal = IERC20Metadata(address(tokens.pair)).balanceOf(
            address(this)
        );
        approveUnapproved(
            address(tokens.cAhlp),
            IERC20Metadata(address(tokens.pair)),
            ahlpBal
        );
        uint256 code = tokens.cAhlp.mint(ahlpBal);
        require(
            code == 0,
            string(
                abi.encodePacked("AHLevPos: fuse mint ", Strings.toString(code))
            )
        );

        // Borrow the same amount of stables from Fuse/Midas as was borrowed in the flashloan
        // TODO: call approve on cStable
        uint256 amountStableFlashloanRepay = amount + fee;
        approveUnapproved(
            address(tokens.cStable),
            tokens.stable,
            amountStableFlashloanRepay
        );
        code = tokens.cStable.borrow(amountStableFlashloanRepay);
        require(
            code == 0,
            string(
                abi.encodePacked(
                    "AHLevPos: fuse borrow ",
                    Strings.toString(code)
                )
            )
        );

        IFlashloanWrapper flw = factory.flw();

        // Repay the flashloan
        approveUnapproved(
            address(flw),
            tokens.stable,
            amountStableFlashloanRepay
        );

        flw.repayFlashLoan(tokens.stable, amountStableFlashloanRepay);
    }

    /**
     * @param amountStableRepay The amount of stables to borrow from a flashloan and
     *      repay the Fuse/Midas debt. This needs to account for the flashloan fee in
     *      order to not increase the overall leverage level of the position. For example
     *      if leverage is 10x and withdrawing $10 of stables to the user, means
     *      withdrawing $100 of AHLP tokens, which means needing to flashloan borrow
     *      $90 of stables - which has a fee of $0.27 if the fee is 0.3%. Therefore
     *      `amountStableRepay` needs to be $90 / 0.997 = 90.2708... to account for
     *      paying the $0.27 and then the extra $0.0008... for the fee on the $0.27 etc.
     */
    function withdrawLev(
        TokensLev memory tokens,
        IDeltaNeutralStableVolatilePairUpgradeable.UniArgs calldata uniArgs,
        uint256 amountStableWithdraw,
        uint256 amountStableRepay,
        uint256 amountAhlpRedeem,
        uint256 leverageRatio
    ) external onlyOwner nonReentrant {
        // It seems odd that we have to specify 3 amounts in `withdrawLev` compared
        // to 2 amounts in `depositLev`. Fundamentally that's because the inputs to
        // `deposit` are in units of stables, and we can use however many AHLP
        // tokens that `deposit` gave us as collateral afterwards. Since `withdraw`
        // uses units of AHLP tokens, we could use only units of AHLP tokens in
        // `depositLev`, using amountAhlpRepay & amountAhlpWithdraw, which looks like:
        //      Take out flashloan for amountAhlpRepay AHLP tokens
        //      `withdraw` them to the same value of stables
        //      Read the stables balance and repay that amount of debt of stables
        //      Withdraw amountAhlpRepay + amountAhlpWithdraw AHLP tokens from Fuse/Midas
        //      Repay amountAhlpRepay + fee AHLP tokens to the flashloan
        //      Withdraw amountAhlpWithdraw AHLP tokens to stables and send to user
        // The issue with this is that it calls `withdraw` twice, which is very expensive,
        // and also just generally inefficient, and it's probably not possible to
        // take out a flashloan of AHLP tokens soon. Better to use the current method

        // Take a flashloan for the amount that needs to be borrowed
        bytes memory loanData = abi.encode(
            1,
            address(this),
            tokens,
            uniArgs,
            amountStableWithdraw,
            amountAhlpRedeem,
            msg.sender
        );

        IFlashloanWrapper flw = factory.flw();
        flw.takeOutFlashLoan(tokens.stable, amountStableRepay, loanData);
    }

    function initiateWithdraw(
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override {
        (
            uint256 loanType,
            address lvgPos,
            TokensLev memory tokens,
            IDeltaNeutralStableVolatilePairUpgradeable.UniArgs memory uniArgs,
            uint256 amountStableWithdraw,
            uint256 amountAhlpRedeem,
            address to
        ) = abi.decode(
                data,
                (
                    uint256,
                    address,
                    TokensLev,
                    IDeltaNeutralStableVolatilePairUpgradeable.UniArgs,
                    uint256,
                    uint256,
                    address
                )
            );
        uint256 loanAmount = amount;
        uint256 loanFee = fee;
        // Repay borrowed stables in Fuse to free up collat
        uint256 code = tokens.cStable.repayBorrow(loanAmount);
        require(
            code == 0,
            string(
                abi.encodePacked(
                    "AHLevPos: fuse repayBorrow ",
                    Strings.toString(code)
                )
            )
        );
        // Take the AHLP collat out of Fuse/Midas
        code = tokens.cAhlp.redeemUnderlying(amountAhlpRedeem);
        require(
            code == 0,
            string(
                abi.encodePacked(
                    "AHLevPos: fuse redeemUnderlying ",
                    Strings.toString(code)
                )
            )
        );

        // Withdraw stables from the AHLP collat
        uint256 amountStablesFromAhlp = tokens.pair.withdraw(
            amountAhlpRedeem,
            uniArgs
        );
        require(
            amountStablesFromAhlp >=
                loanAmount + loanFee + amountStableWithdraw,
            "AHLevPos: not enough withdrawn"
        );
        IFlashloanWrapper flw = factory.flw();

        // Repay the flashloan
        approveUnapproved(address(flw), tokens.stable, loanAmount + loanFee);

        flw.repayFlashLoan(tokens.stable, loanAmount + loanFee);

        // Use any excess stables to repay debt, keeping good ratio safer than sending to the user
        uint256 amountStableExcess = amountStablesFromAhlp -
            loanAmount -
            loanFee -
            amountStableWithdraw;
        tokens.cStable.mint(amountStableExcess);

        // Send the user their #madgainz
        tokens.stable.safeTransfer(to, amountStableWithdraw);

        emit WithdrawLev(
            address(tokens.pair),
            amountStableWithdraw,
            loanAmount,
            amountAhlpRedeem,
            amountStableExcess
        );
    }

    // fcns to withdraw tokens incase of liquidation

    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////
    ////                                                          ////
    ////-------------------------Helpers--------------------------////
    ////                                                          ////
    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////

    function approveUnapproved(
        address target,
        IERC20Metadata token,
        uint256 amount
    ) private {
        if (token.allowance(address(this), address(target)) < amount) {
            token.approve(address(target), MAX_UINT);
        }
    }

    function transferApproveUnapproved(
        address target,
        IERC20Metadata token,
        uint256 amount
    ) private {
        approveUnapproved(target, token, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function getFeeFactor() external view returns (uint256) {
        IFlashloanWrapper flw = factory.flw();
        return flw.getFeeFactor();
    }
}
