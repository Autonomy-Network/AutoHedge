pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV2Router02.sol";
import "../interfaces/IComptroller.sol";
import "../interfaces/ICErc20.sol";
import "../interfaces/IDeltaNeutralStableVolatilePair.sol";
import "./UniswapV2ERC20.sol";
import "./Math.sol";

import "hardhat/console.sol";


/**
* @title    DeltaNeutralPair
* @notice   TODO
* @author   Quantaf1re (James Key)
*/
contract DeltaNeutralStableVolatilePair is IDeltaNeutralStableVolatilePair, Ownable, ReentrancyGuard, UniswapV2ERC20 {
    using SafeERC20 for IERC20;

    uint public constant MINIMUM_LIQUIDITY = 10**3;
    uint public constant FULL_BPS = 10000;

    address payable public registry;
    address public userFeeVeriForwarder;

    IUniswapV2Factory public uniV2Factory;
    IUniswapV2Router02 public uniV2Router;

    IERC20 public stable;
    ICErc20 public cStable;
    IERC20 public vol;
    ICErc20 public cVol;
    IERC20 public uniLp;
    ICErc20 public cUniLp;

    MmBps public mmBps;
    // TODO put most of the above vars into a struct so it can be tightly packed to save gas when reading

    // TODO add checks on the return values of all Compound fncs for error msgs and revert if not 0, with the code in the revert reason

    event Deposited(uint amountStable, uint amountVol, uint amountUniLp, uint amountStableSwap, uint amountMinted); // TODO check args
    event Withdrawn(); // TODO

    // TODO in testing, test that changing the order of https://github.com/Uniswap/v2-core/blob/4dd59067c76dea4a0e8e4bfdda41877a6b16dedc/contracts/UniswapV2Factory.sol#L25 doesn't change anything
    constructor(
        IUniswapV2Factory uniV2Factory_,
        IUniswapV2Router02 uniV2Router_,
        IERC20 stable_,
        IERC20 vol_,
        string memory name_,
        string memory symbol_,
        address payable registry_,
        address userFeeVeriForwarder_,
        MmBps memory mmBps_,
        IComptroller _comptroller
    ) Ownable() UniswapV2ERC20(name_, symbol_) {
        uniV2Factory = uniV2Factory_;
        uniV2Router = uniV2Router_;
        stable = stable_;
        vol = vol_;
        registry = registry_;
        userFeeVeriForwarder = userFeeVeriForwarder_;
        mmBps = mmBps_;

        IERC20 _uniLp = IERC20(uniV2Factory_.getPair(address(stable_), address(vol_)));
        uniLp = _uniLp;

        address _cStable = _comptroller.cTokensByUnderlying(address(stable_));
        cStable = ICErc20(_cStable);
        address _cVol = _comptroller.cTokensByUnderlying(address(vol_));
        cVol = ICErc20(_cVol);
        address _cUniLp = _comptroller.cTokensByUnderlying(address(_uniLp));
        cUniLp = ICErc20(_cUniLp);

        address[] memory cTokens = new address[](3);
        cTokens[0] = _cStable;
        cTokens[1] = _cVol;
        cTokens[2] = _cUniLp;
        uint[] memory results = _comptroller.enterMarkets(cTokens);
        require(results[0] == 0 && results[1] == 0 && results[2] == 0, "DNPair: unable to enter markets");
    }

    // Need to be able to receive ETH when borrowing it
    receive() external payable {}

    function deposit(
        uint amountStableDesired,
        uint amountVolDesired,
        UniArgs calldata uniArgs,
        address to
    ) external payable override nonReentrant {
        require(
            uniArgs.swapPath[0] == address(vol) && uniArgs.swapPath[uniArgs.swapPath.length-1] == address(stable),
            "DNPair: swap path invalid"
        );

        transferApproveUnapproved(stable, address(uniV2Router), amountStableDesired, msg.sender, address(this));
        transferApproveUnapproved(vol, address(uniV2Router), amountVolDesired, msg.sender, address(this));

        (uint amountStable, uint amountVol, uint amountUniLp) = uniV2Router.addLiquidity(
            address(stable),
            address(vol),
            amountStableDesired,
            amountVolDesired,
            uniArgs.amountStableMin,
            uniArgs.amountVolMin,
            address(this),
            uniArgs.deadline
        );

        // transfer not used tokens back to user
        if (amountStableDesired > amountStable) {
            stable.safeTransfer(msg.sender, amountStableDesired - amountStable);
        }
        if (amountVolDesired > amountVol) {
            vol.safeTransfer(msg.sender, amountVolDesired - amountVol);
        }

        // Mint meta-LP tokens to the user. Need to do this after LPing so we know the exact amount of
        // assets that are LP'd with, but before affecting any of the borrowing so it simplifies those
        // calculations.
        uint liquidity = _mintLiquidity(to, amountStable, amountVol, amountUniLp);

        // Use LP token as collateral
        approveUnapproved(uniLp, address(cUniLp), amountUniLp);
        uint code = cUniLp.mint(amountUniLp);
        require(code == 0, string(abi.encodePacked("DNPair: fuse LP mint ", Strings.toString(code)))); // TODO

        // Borrow the volatile token
        code = cVol.borrow(10000);
        require(code == 0, string(abi.encodePacked("DNPair: fuse borrow ", Strings.toString(code))));

        // // Swap the volatile token for the stable token
        // approveUnapproved(vol, address(uniV2Router), amountVol);
        // uint[] memory amounts = uniV2Router.swapExactTokensForTokens(
        //     amountVol, uniArgs.swapAmountOutMin, uniArgs.swapPath, address(this), block.timestamp
        // );

        // // Lend out the stable token again
        // approveUnapproved(stable, address(cStable), amounts[amounts.length-1]);
        // code = cStable.mint(amounts[amounts.length-1]);

        // require(code == 0, string(abi.encodePacked("DNPair: fuse stable mint ", Strings.toString(code))));

        // // TODO check if things need rebalancing already, because by trading the volatile token for the stable token, we moved the market
        // // rebalance(5 * 10**9);

        // emit Deposited(amountStable, amountVol, amountUniLp, amounts[amounts.length-1], liquidity);
    }

    function withdraw(
        uint liquidity,
        UniArgs calldata uniArgs
    ) external override {
        require(
            uniArgs.swapPath[0] == address(stable) && uniArgs.swapPath[uniArgs.swapPath.length-1] == address(vol),
            "DNPair: swap path invalid"
        );
        // Get the user's portion of the assets in Uniswap
        uint _totalSupply = totalSupply;
        uint code;

        // Get the stables lent out and convert them back into the volatile token
        uint amountStableFromLending = cStable.balanceOfUnderlying(address(this)) * liquidity / _totalSupply;
        code = cStable.redeemUnderlying(amountStableFromLending);
        require(code == 0, string(abi.encodePacked("DNPair: fuse stable redeem ", Strings.toString(code))));

        uint amountVolFromStable = uniV2Router.swapExactTokensForTokens(
            amountStableFromLending, uniArgs.swapAmountOutMin, uniArgs.swapPath, address(this), block.timestamp
        )[uniArgs.swapPath.length-1];

        // Pay back the borrowed volatile
        uint amountVolToRepay = cVol.borrowBalanceCurrent(address(this)) * liquidity / _totalSupply;
        approveUnapproved(vol, address(cVol), amountVolToRepay);

        // Repay the borrowed volatile depending on how much we have
        if (amountVolToRepay <= amountVolFromStable) {
            code = cVol.repayBorrow(amountVolToRepay);
        } else {
            // If we don't have enough, pay with what we have and account for the difference later after getting enough
            // assets back from the DEX
            code = cVol.repayBorrow(amountVolFromStable);
        }

        require(code == 0, string(abi.encodePacked("DNPair: fuse vol repay ", Strings.toString(code))));
        uint amountUniLp = ICErc20(cUniLp).balanceOfUnderlying(address(this)) * liquidity / _totalSupply;

        approveUnapproved(uniLp, address(uniV2Router), amountUniLp); // TODO: make this and similar to be uniV2Router
        if (amountVolToRepay <= amountVolFromStable) {
            // Redeem everything and remove all liquidity from Uniswap
            code = cUniLp.redeemUnderlying(amountUniLp);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem ", Strings.toString(code))));

            uniV2Router.removeLiquidity(
                address(stable),
                address(vol),
                amountUniLp,
                uniArgs.amountStableMin,
                uniArgs.amountVolMin,
                msg.sender,
                uniArgs.deadline
            );
        } else {
            // Redeem enough from Fuse so that we can then remove enough liquidity from Uniswap to cover the
            // remaining owed volatile amount, then redeem the remaining amount from Fuse and remove the
            // remaining amount from Uniswap
            
            // Redeem an amount of the Uniswap LP token, proportional to the amount of
            // the volatile we could get from stables compared to how much is needed, so
            // that it's impossible (?) to redeem too much and be undercollateralised
            uint amountUniLpPaidFirst = amountUniLp * amountVolFromStable / amountVolToRepay;
            code = cUniLp.redeemUnderlying(amountUniLpPaidFirst);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem 1 ", Strings.toString(code))));
            
            // To avoid stack too deep
            UniArgs memory uniArgs = uniArgs;

            (, uint amountVolFromDex) = uniV2Router.removeLiquidity(
                address(stable),
                address(vol),
                amountUniLpPaidFirst,
                uniArgs.amountStableMin * amountUniLpPaidFirst / amountUniLp,
                uniArgs.amountVolMin * amountUniLpPaidFirst / amountUniLp,
                address(this),
                uniArgs.deadline
            );
            require(amountVolFromDex > amountVolToRepay - amountVolFromStable, "DNPair: vol cant cover defecit");

            code = cUniLp.redeemUnderlying(amountUniLp - amountUniLpPaidFirst);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem 2 ", Strings.toString(code))));

            uniV2Router.removeLiquidity(
                address(stable),
                address(vol),
                amountUniLp - amountUniLpPaidFirst,
                uniArgs.amountStableMin * (amountUniLp - amountUniLpPaidFirst) / amountUniLp,
                uniArgs.amountVolMin * (amountUniLp - amountUniLpPaidFirst) / amountUniLp,
                address(this),
                uniArgs.deadline
            );

            // TODO: take into account that this contract has MINIMUM_LIQUIDITY tokens which would
            // be taken by these lines if a pair was made for its own AH liquidity token
            vol.safeTransfer(msg.sender, vol.balanceOf(address(this)));
            stable.safeTransfer(msg.sender, stable.balanceOf(address(this)));
        }

        _burn(msg.sender, liquidity);

        emit Withdrawn(); // TODO
    }

    // TODO return token addresses


    /**
     * @notice  Checks how much of the non-stablecoin asset we have being LP'd with on IDEX (amount X) and
     *          how much debt we have in that asset at ILendingPlatform, and borrows/repays the debt to be equal to X,
     *          if and only if the difference is more than 1%.
     *          This function is what is automatically called by Autonomy.
     */
    function rebalanceAuto(
        address user,
        uint feeAmount,
        uint maxGasPrice
    ) public override gasPriceCheck(maxGasPrice) userFeeVerified {
        
    }

    // TODO: need to account for when there isn't enough stablecoins being lent out to repay
    // TODO: use a constant for the timestamp to reduce gas
   function rebalance(uint feeAmount) public {
       (uint ownedAmountVol, uint debtAmountVol, uint debtBps) = getDebtBps();
       // If there's ETH in this contract, then it's for the purpose of subsidising the
       // automation fee, and so we don't need to get funds from elsewhere to pay it
       bool payFeeFromBal = feeAmount >= address(this).balance;
       address[] memory pathStableToVol = newPath(stable, vol);
       address[] memory pathVolToStable = newPath(vol, stable);
       MmBps memory mb = mmBps;

       if (debtBps >= mb.max) {
           // Repay some debt
           uint amountVolToRepay = debtAmountVol - ownedAmountVol;
           uint[] memory amountsForVol = uniV2Router.getAmountsIn(amountVolToRepay, pathStableToVol);
           uint amountStableToRedeem = amountsForVol[0];
           address[] memory pathFee;

           if (feeAmount > 0 && !payFeeFromBal) {
               if (feeAmount > address(this).balance) {
                   registry.transfer(feeAmount);
               } else {
                   pathFee = newPath(stable, IERC20(uniV2Factory.WETH()));
                   uint[] memory amountsForFee = uniV2Router.getAmountsIn(feeAmount, pathFee);
                   amountStableToRedeem += amountsForFee[0];
               }
           }

           cStable.redeem(amountStableToRedeem);
           approveUnapproved(stable, address(uniV2Router), amountStableToRedeem);
           uniV2Router.swapTokensForExactTokens(amountVolToRepay, amountsForVol[0], pathStableToVol, address(this), block.timestamp);
           cVol.repayBorrow(amountVolToRepay);

           if (feeAmount > 0 && !payFeeFromBal) {
               uniV2Router.swapTokensForExactETH(feeAmount, amountStableToRedeem-amountsForVol[0], pathFee, registry, block.timestamp);
           }
       } else if (debtBps <= mb.min) {
           // Borrow more
           uint amountVolBorrow = ownedAmountVol - debtAmountVol;
           cVol.borrow(amountVolBorrow);

           if (feeAmount > 0 && !payFeeFromBal) {
               address[] memory pathFee = newPath(vol, IERC20(uniV2Factory.WETH())); // TODO: have WETH defined in this contract
               uint[] memory amountsVolToEthForFee = uniV2Router.getAmountsIn(feeAmount, pathFee);

               if (amountsVolToEthForFee[0] < amountVolBorrow) {
                   // Pay the fee
                   uniV2Router.swapTokensForExactETH(feeAmount, amountsVolToEthForFee[0], pathFee, registry, block.timestamp);
                   // Swap the rest to stablecoins and lend them out
                   uint[] memory amountsVolToStable = uniV2Router.swapExactTokensForTokens(amountVolBorrow-amountsVolToEthForFee[0], 1, pathVolToStable, address(this), block.timestamp);
                   cStable.mint(amountsVolToStable[amountsVolToStable.length-1]);
               } else if (amountsVolToEthForFee[0] > amountVolBorrow) {
                   // Get the missing volatile tokens needed for the fee from the lent out stablecoins
                   uint amountVolNeeded = amountsVolToEthForFee[0] - amountVolBorrow;
                   uint[] memory amountsStableToVolForFee = uniV2Router.getAmountsIn(amountVolNeeded, pathStableToVol);
                   cStable.redeem(amountsStableToVolForFee[0]);
                   uniV2Router.swapTokensForExactTokens(amountVolNeeded, amountsStableToVolForFee[0], pathStableToVol, address(this), block.timestamp);
                   uniV2Router.swapTokensForExactETH(feeAmount, amountsVolToEthForFee[0], pathFee, registry, block.timestamp);
               } else {
                   uniV2Router.swapTokensForExactETH(feeAmount, amountVolBorrow, pathFee, registry, block.timestamp);
               }
           }
       } else {
           require(false, "DNPair: debt within range");
       }

       if (payFeeFromBal) {
           registry.transfer(feeAmount);
       }

       (ownedAmountVol, debtAmountVol, debtBps) = getDebtBps();
       require(debtBps >= mb.min && debtBps <= mb.max, "DNPair: debt not within range");
   }

    // TODO: mark as view, issue with balanceOfUnderlying not being view
    function getDebtBps() public override returns (uint ownedAmountVol, uint debtAmountVol, uint debtBps) {
        // ownedAmountVol = getVolAmountFromUniswap();
        ownedAmountVol = 0; // just to get this to compile
        debtAmountVol = cVol.balanceOfUnderlying(address(this));
        debtBps = debtAmountVol * FULL_BPS / ownedAmountVol;
    }

    // TODO: add owner
    function setMmBps(MmBps calldata newMmBps) external override {
        mmBps = newMmBps;
    }

    function _mintLiquidity(address to, uint amountStable, uint amountVol, uint amountUniLp) private returns (uint liquidity) {
        (uint reserveStable, uint reserveVol, uint _totalSupply) = getReserves(amountStable, amountVol, amountUniLp);
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amountStable * amountVol) - MINIMUM_LIQUIDITY; // TODO ?
           _mint(address(this), MINIMUM_LIQUIDITY); // permanently lock the first MINIMUM_LIQUIDITY tokens
        } else {
            liquidity = Math.min(amountStable * _totalSupply / reserveStable, amountVol * _totalSupply / reserveVol);
        }
        require(liquidity > 0, 'DNPair: INSUFFICIENT_LIQUIDITY_MINTED');
        _mint(to, liquidity);
    }

    // TODO return token addresses
    function getReserves(uint amountStable, uint amountVol, uint amountUniLp) public returns (uint, uint, uint) {

        IERC20 _stable = stable; // gas savings
        IERC20 _vol = vol; // gas savings
        uint dexLiquidity = cUniLp.balanceOfUnderlying(address(this)) + amountUniLp;
        uint totalDexLiquidity = uniLp.totalSupply();

        uint reserveStable;
        uint dexBalVol;
        if (dexLiquidity - amountUniLp > 0) { // avoid underflow
            reserveStable = (_stable.balanceOf(address(uniLp)) * dexLiquidity / totalDexLiquidity) - amountStable;
            dexBalVol = (_vol.balanceOf(address(uniLp)) * dexLiquidity / totalDexLiquidity) - amountVol;
        }

        // Need to calculate how much of the volatile asset we'd be left with if we liquidated and
        // withdrew everything, tho TODO: could simplify this greatly and only consider the stable above
        uint amountStableLentOut = cStable.balanceOfUnderlying(address(this));
        uint amountVolFromStable;
        if (amountStableLentOut > 0) {
            uint[] memory amountsVolFromStable = uniV2Router.getAmountsOut(
                amountStableLentOut,
                newPath(stable, vol)
            );
            amountVolFromStable = amountsVolFromStable[amountsVolFromStable.length-1];
        }

        // The balance in Uniswap, plus the amount of stables lent out with interest, minus the debt with interest
        uint reserveVol = dexBalVol + amountVolFromStable - cVol.borrowBalanceCurrent(address(this));


        return (reserveStable, reserveVol, this.totalSupply());
    }

    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////
    ////                                                          ////
    ////-------------------------Helpers--------------------------////
    ////                                                          ////
    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////

    modifier gasPriceCheck(uint maxGasPrice) {
        require(tx.gasprice <= maxGasPrice, "LimitsStops: gasPrice too high");
        _;
    }

    function transferApproveUnapproved(
        IERC20 token,
        address approvalRecipient,
        uint amount,
        address user,
        address to
    ) private {
        approveUnapproved(token, approvalRecipient, amount);
        token.safeTransferFrom(user, to, amount);
    }

    function approveUnapproved(IERC20 token, address approvalRecipient, uint amount) private {
        if (token.allowance(address(this), approvalRecipient) < amount) {
            token.safeApprove(approvalRecipient, type(uint256).max);
        }
    }

    function newPath(IERC20 src, IERC20 dest) public pure returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = address(src);
        path[1] = address(dest);
        return path;
    }

    modifier userFeeVerified() {
        require(msg.sender == userFeeVeriForwarder, "LimitsStops: not userFeeForw");
        _;
    }
}
