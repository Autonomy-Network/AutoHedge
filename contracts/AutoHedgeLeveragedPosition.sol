pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../interfaces/ICErc20.sol";
import "../interfaces/IFlashloanWrapper.sol";
import "../interfaces/IComptroller.sol";

import "hardhat/console.sol";


contract AutoHedgeLeveragedPosition is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    function initialize(IFlashloanWrapper flw_) external initializer {
        flw = flw_;
    }

    using SafeERC20 for IERC20Metadata;

    uint private constant BASE_FACTOR = 1e18;
    uint private constant MAX_UINT = type(uint256).max;

    IFlashloanWrapper public flw;

    struct TokensLev {
        IERC20Metadata stable;
        ICErc20 cStable;
        IERC20Metadata vol;
        ICErc20 cVol;
        IERC20Metadata uniLp;
        ICErc20 cUniLp;
        IDeltaNeutralStableVolatilePairUpgradeable pair;
        ICErc20 cAhlp;
    }

    /**
     * @param amountStableBorrow The amount of stables to borrow from a flashloan and
     *      be repaid by the FuseMidas debt. This needs to account for the flashloan
     *      fee in order to not increase the overall leverage ratio by reducing the
     *      amount

     *      repay the Fuse/Midas debt. This needs to account for the flashloan fee in
     *      order to not change the overall leverage level of the position. For example
     *      if leverage is 10x and withdrawing $10 of stables to the user, means
     *      withdrawing $100 of AHLP tokens, which means needing to flashloan borrow
     *      $90 of stables - which has a fee of $0.27 if the fee is 0.3%. Therefore
     *      `amountStableRepay` needs to be $90 / 0.997 = 90.2708... to account for
     *      paying the $0.27 and then the extra $0.0008... for the fee on the $0.27
     */
    function depositLev(
        IComptroller comptroller,
        TokensLev memory tokens,
        uint amountVolZapMin,
        IDeltaNeutralStableVolatilePairUpgradeable.UniArgs calldata uniArgs,
        address referrer,
        uint amountStableDeposit,
        uint amountStableBorrow
    ) external onlyOwner nonReentrant {
        require(amountStableBorrow > 0, "AHLevPos: total less than init");

        // Enter the relevant markets on Fuse/Midas
        address[] memory cTokens = new address[](4);
        cTokens[0] = address(tokens.cStable);
        cTokens[1] = address(tokens.cVol);
        cTokens[2] = address(tokens.cUniLp);
        cTokens[3] = address(tokens.cAhlp);
        uint[] memory results = comptroller.enterMarkets(cTokens);
        require(results[0] == 0 && results[1] == 0 && results[2] == 0 && results[3] == 0, "AHLevPos: cant enter markets");

        transferApproveUnapproved(address(tokens.pair), tokens.stable, amountStableDeposit);

        // Take out a flashloan for the amount that needs to be borrowed
        uint stableBalBefore = tokens.stable.balanceOf(address(this));
        uint feeAmount = flw.takeOutFlashLoan(address(tokens.stable), amountStableBorrow);
        require(tokens.stable.balanceOf(address(this)) == stableBalBefore + amountStableBorrow);

        // Deposit all stables (except for the flashloan fee) from the user and flashloan to AH
        tokens.pair.deposit(
            amountStableDeposit + amountStableBorrow - feeAmount,
            amountVolZapMin,
            uniArgs,
            address(this),
            referrer
        );



        // TODO: Need to account for the fee of AH




        // Put all AHLP tokens as collateral
        uint code = tokens.cAhlp.mint(IERC20Metadata(address(tokens.pair)).balanceOf(address(this)));
        require(code == 0, string(abi.encodePacked("AHLevPos: fuse mint ", Strings.toString(code))));

        // Borrow the same amount of stables from Fuse/Midas as was borrowed in the flashloan
        code = tokens.cStable.borrow(amountStableBorrow);
        require(code == 0, string(abi.encodePacked("AHLevPos: fuse borrow ", Strings.toString(code))));

        // Repay the flashloan
        approveUnapproved(address(flw), tokens.stable, amountStableBorrow + feeAmount);
        flw.repayFlashLoan(address(tokens.stable), amountStableBorrow + feeAmount);

        // TODO: Some checks requiring that the positions are what they should be everywhere
        // TODO: Check that the collat ratio is above some value
        // TODO: Do these checks on withdrawLev too
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
        uint amountStableWithdraw,
        uint amountStableRepay,
        uint amountAhlpRedeem,
        uint leverageRatio
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
        uint stableBalBefore = tokens.stable.balanceOf(address(this));
        uint feeAmount = flw.takeOutFlashLoan(address(tokens.stable), amountStableRepay);
        require(tokens.stable.balanceOf(address(this)) == stableBalBefore + amountStableRepay);

        // Repay borrowed stables in Fuse to free up collat
        uint code = tokens.cStable.repayBorrow(amountStableRepay);
        require(code == 0, string(abi.encodePacked("AHLevPos: fuse repayBorrow ", Strings.toString(code))));

        // Take the AHLP collat out of Fuse/Midas
        code = tokens.cAhlp.redeemUnderlying(amountAhlpRedeem);
        require(code == 0, string(abi.encodePacked("AHLevPos: fuse redeemUnderlying ", Strings.toString(code))));

        // Withdraw stables from the AHLP collat
        uint amountStablesFromAhlp = tokens.pair.withdraw(amountAhlpRedeem, uniArgs);
        require(amountStablesFromAhlp >= amountStableRepay + feeAmount + amountStableWithdraw, "AHLevPos: not enough withdrawn");

        // Repay the flashloan
        approveUnapproved(address(flw), tokens.stable, amountStableRepay + feeAmount);
        flw.repayFlashLoan(address(tokens.stable), amountStableRepay + feeAmount);

        // Use any excess stables to repay debt, keeping good ratio safer than sending to the user
        tokens.cStable.mint(amountStablesFromAhlp - amountStableRepay - feeAmount - amountStableWithdraw);

        // Send the user their #madgainz
        tokens.stable.safeTransfer(msg.sender, amountStableWithdraw);
    }

    // Withdrawing 5k, 50k leveraged amount, 0.3% fee from flashloan = $135
    // Take flashloan of $45k stables
    // Repay $45,135 stables debt
    // Take $50k AHLP tokens from collat
    // Convert to $50k stables
    // Repay $45,135 stables
    // Withdraw $5k back to the user

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
        uint amount
    ) private {
        if (token.allowance(address(this), address(target)) < amount) {
            token.approve(address(target), MAX_UINT);
        }
    }

    function transferApproveUnapproved(
        address target,
        IERC20Metadata token,
        uint amount
    ) private {
        approveUnapproved(target, token, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function getFeeFactor() external view returns (uint) {
        return flw.getFeeFactor();
    }
}