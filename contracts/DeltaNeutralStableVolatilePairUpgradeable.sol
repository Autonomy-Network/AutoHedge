pragma solidity 0.8.6;


import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV2Router02.sol";
import "../interfaces/IComptroller.sol";
import "../interfaces/ICErc20.sol";
import "../interfaces/IDeltaNeutralStableVolatilePairUpgradeable.sol";
import "../interfaces/IDeltaNeutralStableVolatileFactoryUpgradeable.sol";
import "../interfaces/IWETH.sol";
import "../interfaces/autonomy/IRegistry.sol";
import "./UniswapV2ERC20Upgradeable.sol";
import "./Maths.sol";

import "hardhat/console.sol";


/**
* @title    AutoHedgeStableVolatilePair
* @notice   AutoHedge allows users to LP on DEXes while remaining
*           delta-neutral, i.e. if they deposit $100 onto an AH
*           pair that has an underlying DEX pair of DAI-ETH, then
*           even when the price of ETH doubles or halves, the position
*           value is still worth exactly $100, and accumulates LP
*           trading fees ontop. This is the 1st iteration of AH and
*           only works with a DEX pair where 1 of the assets is a
*           stablecoin.
* @author   Quantaf1re (James Key)
*/
contract DeltaNeutralStableVolatilePairUpgradeable is IDeltaNeutralStableVolatilePairUpgradeable, Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UniswapV2ERC20Upgradeable {
    
    using SafeERC20 for IERC20Metadata;

    function initialize(
        IUniswapV2Router02 uniV2Router_,
        Tokens memory tokens_,
        IERC20Metadata weth_,
        string memory name_,
        string memory symbol_,
        IRegistry registry_,
        address userFeeVeriForwarder_,
        MmBps memory mmBps_,
        IComptroller _comptroller,
        IDeltaNeutralStableVolatileFactoryUpgradeable factory_
    ) public override initializer {
        __Ownable_init_unchained();
        __UniswapV2ERC20Upgradeable__init_unchained(name_, symbol_);

        uniV2Router = uniV2Router_;
        tokens = tokens_;
        weth = weth_;
        registry = registry_;
        userFeeVeriForwarder = userFeeVeriForwarder_;
        mmBps = mmBps_;
        factory = factory_;

        tokens_.stable.safeApprove(address(uniV2Router), MAX_UINT);
        tokens_.stable.safeApprove(address(tokens_.cStable), MAX_UINT);
        tokens_.vol.safeApprove(address(uniV2Router), MAX_UINT);
        tokens_.vol.safeApprove(address(tokens_.cVol), MAX_UINT);
        tokens_.uniLp.safeApprove(address(uniV2Router), MAX_UINT);
        tokens_.uniLp.safeApprove(address(tokens_.cUniLp), MAX_UINT);

        address[] memory cTokens = new address[](3);
        cTokens[0] = address(tokens_.cStable);
        cTokens[1] = address(tokens_.cVol);
        cTokens[2] = address(tokens_.cUniLp);
        uint[] memory results = _comptroller.enterMarkets(cTokens);
        require(results[0] == 0 && results[1] == 0 && results[2] == 0, "DNPair: unable to enter markets");

        autoId = registry_.newReqPaySpecific(
            address(this),
            payable(address(0)),
            abi.encodeWithSelector(this.rebalanceAuto.selector, address(this), 0),
            0,
            true,
            true,
            false,
            true
        );
    }

    uint private constant MINIMUM_LIQUIDITY = 10**3;
    uint private constant BASE_FACTOR = 1e18;
    uint private constant MAX_UINT = type(uint256).max;

    IRegistry public registry;
    address public userFeeVeriForwarder;
    uint public autoId;

    IUniswapV2Router02 public uniV2Router;

    Tokens public tokens;
    IERC20Metadata public weth;

    MmBps public mmBps;

    IDeltaNeutralStableVolatileFactoryUpgradeable public override factory;


    function deposit(
        uint amountStableInit,
        uint amountVolZapMin,
        UniArgs calldata uniArgs,
        address to,
        address referrer
    ) external override nonReentrant returns (uint amountStable, uint amountVol, uint amountUniLp) {
        Tokens memory _tokens = tokens; // Gas savings
        require(
            uniArgs.pathVolToStable[0] == address(_tokens.vol) &&
            uniArgs.pathVolToStable[uniArgs.pathVolToStable.length-1] == address(_tokens.stable) &&
            uniArgs.pathStableToVol[0] == address(_tokens.stable) &&
            uniArgs.pathStableToVol[uniArgs.pathStableToVol.length-1] == address(_tokens.vol),
            "DNPair: swap path invalid"
        );

        UniArgs memory uniArgs = uniArgs;

        // Get stables from the user and swap to receive `amountVolZapMin` of the volatile token
        _tokens.stable.safeTransferFrom(msg.sender, address(this), amountStableInit);
        uint[] memory amountsStableToVol = uniV2Router.swapExactTokensForTokens(
            amountStableInit/2,
            amountVolZapMin,
            uniArgs.pathStableToVol,
            address(this),
            block.timestamp
        );

        (amountStable, amountVol, amountUniLp) = uniV2Router.addLiquidity(
            address(_tokens.stable),
            address(_tokens.vol),
            amountStableInit - amountsStableToVol[0],
            amountsStableToVol[amountsStableToVol.length-1],
            uniArgs.amountStableMin,
            uniArgs.amountVolMin,
            address(this),
            uniArgs.deadline
        );

        // Transfer not used tokens back to the user
        if (amountStableInit > amountsStableToVol[0] + amountStable) {
            _tokens.stable.safeTransfer(msg.sender, amountStableInit - amountsStableToVol[0] - amountStable);
        }
        if (amountsStableToVol[amountsStableToVol.length-1] > amountVol) {
            uniV2Router.swapExactTokensForTokens(
                amountsStableToVol[amountsStableToVol.length-1] - amountVol,
                1,
                uniArgs.pathVolToStable,
                msg.sender,
                block.timestamp
            );
        }

        // Need to know the % increase of the Uniswap position so that we give a proportional increase
        // to the stablecoin lending position and the AutoHedge LP token
        uint currentUniLpBal = _tokens.cUniLp.balanceOfUnderlying(address(this));
        uint increaseFactor = currentUniLpBal == 0 ? 0 : amountUniLp * BASE_FACTOR / currentUniLpBal;

        address feeReceiver = referrer;

        if (feeReceiver == address(0)) {
            feeReceiver = factory.feeReceiver();
        }
        
        // Mint AutoHedge LP tokens to the user. Need to do this after LPing so we know the exact amount of
        // assets that are LP'd with, but before affecting any of the borrowing so it simplifies those
        // calculations
        (, uint liquidityForUser) = _mintLiquidity(to, feeReceiver, amountStable, amountVol, increaseFactor);
        
        // Use LP token as collateral
        uint code = _tokens.cUniLp.mint(amountUniLp);
        require(code == 0, string(abi.encodePacked("DNPair: fuse LP mint ", Strings.toString(code))));

        // Borrow the volatile token
        code = _tokens.cVol.borrow(amountVol);
        require(code == 0, string(abi.encodePacked("DNPair: fuse borrow ", Strings.toString(code))));

        // Swap the volatile token for the stable token
        uint[] memory amountsVolToStable = uniV2Router.swapExactTokensForTokens(
            amountVol, uniArgs.swapAmountOutMin, uniArgs.pathVolToStable, address(this), block.timestamp
        );
        
        // Lend out the stable token again. Need to increase this by the same % that the Uniswap position
        // was increased by, and either cover any extra from the user or send some back to the user if
        // they would effectively overpay
        uint lendIncrease = _tokens.cStable.balanceOfUnderlying(address(this)) * increaseFactor / BASE_FACTOR;
        // If there is nothing lent out (`lendIncrease` is zero), or if we need to lend out
        // exactly what we have, then just lend out what we have
        if (lendIncrease == 0 || lendIncrease == amountsVolToStable[amountsVolToStable.length-1]) {
            code = _tokens.cStable.mint(amountsVolToStable[amountsVolToStable.length-1]);
        } else {
            // If there are more stablecoins than needed to lend, send the rest back and lend
            if (lendIncrease < amountsVolToStable[amountsVolToStable.length-1]) {
                _tokens.stable.safeTransfer(msg.sender, amountsVolToStable[amountsVolToStable.length-1] - lendIncrease);
            // If more stablecoins are needed, get more from the user and lend
            } else if (lendIncrease > amountsVolToStable[amountsVolToStable.length-1]) {
                _tokens.stable.safeTransferFrom(msg.sender, address(this), lendIncrease - amountsVolToStable[amountsVolToStable.length-1]);
            }
            code = _tokens.cStable.mint(lendIncrease);
        }
        require(code == 0, string(abi.encodePacked("DNPair: fuse stable mint ", Strings.toString(code))));

        emit Deposited(msg.sender, amountStable, amountVol, amountUniLp, amountsVolToStable[amountsVolToStable.length-1], liquidityForUser);
    }

    // This uses the Uniswap LP as a way to cover any extra debt that isn't coverable from the lending position.
    // Another, simpler option is to use the user's funds still in their wallet to cover the difference - this
    // would require they have enough funds in their wallet, but they'd end up paying less gas, the contract
    // would be simpler, and they'd end up with the same $ value at the end anyway (tho maybe not if the trade
    // size is large enough because more funds would be swapped and therefore pay 0.3% fee on)
    function withdraw(
        uint liquidity,
        UniArgs calldata uniArgs
    ) external override nonReentrant returns (uint amountStableToUser) {
        Tokens memory _tokens = tokens; // Gas savings
        require(
            uniArgs.pathVolToStable[0] == address(_tokens.vol) &&
            uniArgs.pathVolToStable[uniArgs.pathVolToStable.length-1] == address(_tokens.stable) &&
            uniArgs.pathStableToVol[0] == address(_tokens.stable) &&
            uniArgs.pathStableToVol[uniArgs.pathStableToVol.length-1] == address(_tokens.vol),
            "DNPair: swap path invalid"
        );
        uint _totalSupply = totalSupply;
        uint code;

        // Get the stables lent out and convert them back into the volatile token
        uint amountStableFromLending = _tokens.cStable.balanceOfUnderlying(address(this)) * liquidity / _totalSupply;
        code = _tokens.cStable.redeemUnderlying(amountStableFromLending);
        require(code == 0, string(abi.encodePacked("DNPair: fuse stable redeem ", Strings.toString(code))));

        uint amountVolFromStable = uniV2Router.swapExactTokensForTokens(
            amountStableFromLending,
            uniArgs.swapAmountOutMin,
            uniArgs.pathStableToVol,
            address(this),
            block.timestamp
        )[uniArgs.pathStableToVol.length-1];

        // Repay the borrowed volatile depending on how much we have
        uint amountVolToRepay = _tokens.cVol.borrowBalanceCurrent(address(this)) * liquidity / _totalSupply;
        if (amountVolToRepay <= amountVolFromStable) {
            code = _tokens.cVol.repayBorrow(amountVolToRepay);
        } else {
            // If we don't have enough, pay with what we have and account for the difference later after getting enough
            // assets back from the DEX
            code = _tokens.cVol.repayBorrow(amountVolFromStable);
        }

        require(code == 0, string(abi.encodePacked("DNPair: fuse vol repay ", Strings.toString(code))));
        uint amountUniLp = _tokens.cUniLp.balanceOfUnderlying(address(this)) * liquidity / _totalSupply;

        // To avoid stack too deep
        UniArgs memory uniArgs = uniArgs;
        
        uint amountVolToSwap;
        if (amountVolToRepay <= amountVolFromStable) {
            // Redeem everything and remove all liquidity from Uniswap
            code = _tokens.cUniLp.redeemUnderlying(amountUniLp);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem 1 ", Strings.toString(code))));

            (, uint amountVolFromDex) = uniV2Router.removeLiquidity(
                address(_tokens.stable),
                address(_tokens.vol),
                amountUniLp,
                uniArgs.amountStableMin,
                uniArgs.amountVolMin,
                address(this),
                uniArgs.deadline
            );
            amountVolToSwap = amountVolFromStable + amountVolFromDex - amountVolToRepay;
        } else {
            // Redeem enough from Fuse so that we can then remove enough liquidity from Uniswap to cover the
            // remaining owed volatile amount, then redeem the remaining amount from Fuse and remove the
            // remaining amount from Uniswap
            
            // Redeem an amount of the Uniswap LP token, proportional to the amount of
            // the volatile we could get from stables compared to how much is needed, so
            // that it's impossible (?) to redeem too much and be undercollateralised
            uint amountUniLpPaidFirst = amountUniLp * amountVolFromStable / amountVolToRepay;
            code = _tokens.cUniLp.redeemUnderlying(amountUniLpPaidFirst);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem 1 ", Strings.toString(code))));
            

            (, uint amountVolFromDex) = uniV2Router.removeLiquidity(
                address(_tokens.stable),
                address(_tokens.vol),
                amountUniLpPaidFirst,
                uniArgs.amountStableMin * amountUniLpPaidFirst / amountUniLp,
                uniArgs.amountVolMin * amountUniLpPaidFirst / amountUniLp,
                address(this),
                uniArgs.deadline
            );

            // Repay the remaining debt
            require(amountVolFromDex > amountVolToRepay - amountVolFromStable, "DNPair: vol cant cover defecit");
            code = _tokens.cVol.repayBorrow(amountVolToRepay - amountVolFromStable);
            require(code == 0, string(abi.encodePacked("DNPair: fuse vol repay 2 ", Strings.toString(code))));

            // Redeem the remaining Uniswap LP tokens
            code = _tokens.cUniLp.redeemUnderlying(amountUniLp - amountUniLpPaidFirst);
            require(code == 0, string(abi.encodePacked("DNPair: fuse LP redeem 2 ", Strings.toString(code))));

            (, uint amountVolFromDex2) = uniV2Router.removeLiquidity(
                address(_tokens.stable),
                address(_tokens.vol),
                amountUniLp - amountUniLpPaidFirst,
                uniArgs.amountStableMin * (amountUniLp - amountUniLpPaidFirst) / amountUniLp,
                uniArgs.amountVolMin * (amountUniLp - amountUniLpPaidFirst) / amountUniLp,
                address(this),
                uniArgs.deadline
            );

            amountVolToSwap = amountVolFromDex + amountVolFromDex2 + amountVolFromStable - amountVolToRepay;
        }

        uniV2Router.swapExactTokensForTokens(
            amountVolToSwap,
            1,
            uniArgs.pathVolToStable,
            address(this),
            block.timestamp
        );

        amountStableToUser = _tokens.stable.balanceOf(address(this));
        _tokens.stable.safeTransfer(msg.sender, amountStableToUser);

        _burn(msg.sender, liquidity);

        emit Withdrawn(msg.sender, amountStableFromLending, amountVolToRepay, liquidity);
    }

    /**
     * @notice  Checks how much of the non-stablecoin asset we have being LP'd with on IDEX (amount X) and
     *          how much debt we have in that asset at ILendingPlatform, and borrows/repays the debt to be equal to X,
     *          if and only if the difference is more than 1%.
     *          This function is what is automatically called by Autonomy.
     */
    function rebalanceAuto(
        address user,
        uint feeAmount
    ) public override nonReentrant {
        require(user == address(this), "DNPair: not user");
        require(msg.sender == userFeeVeriForwarder, "DNPair: not userFeeForw");
        _rebalance(feeAmount, false);
    }

    function rebalance(bool passIfInBounds) public nonReentrant {
        _rebalance(0, passIfInBounds);
    }

    function _rebalance(uint feeAmount, bool passIfInBounds) private {
        Tokens memory _tokens = tokens; // Gas savings
        VolPosition memory volPos = _getDebtBps(_tokens);
        // If there's ETH in this contract, then it's for the purpose of subsidising the
        // automation fee, and so we don't need to get funds from elsewhere to pay it
        bool payFeeFromBal = feeAmount <= address(this).balance;
        address[] memory pathStableToVol = newPath(_tokens.stable, _tokens.vol);
        address[] memory pathVolToStable = newPath(_tokens.vol, _tokens.stable);
        MmBps memory mb = mmBps;
        uint code;

        if (volPos.bps >= mb.max) {
            // Repay some debt
            uint amountVolToRepay = volPos.debt - volPos.owned;
            uint amountStableToRedeem;

            // Need to take account for the fact that `getAmountsIn` used twice on the same
            // pair will return the incorrect amount the 2nd time if the pool has changed by the
            // 2nd trade (because of the 1st trade). `vol == weth` is treated as a special case
            // when paying back debt but not when borrowing more because it's alot more expensive
            // in the latter case to redeem stablecoins from the lending position twice, and 
            // we start borrowing more debt with a known quantity of the volatile token, whereas with
            // paying back debt, we have to figure out how much stablecoins to redeem to get the
            // required amount of volatile tokens
            if (_tokens.vol == weth) {
                // Get enough WETH
                uint amountVolNeeded = !payFeeFromBal ? amountVolToRepay + feeAmount : amountVolToRepay;
                amountStableToRedeem = uniV2Router.getAmountsIn(amountVolNeeded, pathStableToVol)[0];
                code = _tokens.cStable.redeemUnderlying(amountStableToRedeem);
                require(code == 0, string(abi.encodePacked("DNPair: fuse redeem underlying ", Strings.toString(code))));
                uniV2Router.swapTokensForExactTokens(
                    amountVolNeeded,
                    amountStableToRedeem,
                    pathStableToVol,
                    address(this),
                    block.timestamp
                );

                // Repay the debt
                code = _tokens.cVol.repayBorrow(amountVolToRepay);
                require(code == 0, string(abi.encodePacked("DNPair: fuse repay borrow WETH ", Strings.toString(code))));

                // Pay `feeAmount`
                if (feeAmount > 0 && !payFeeFromBal) {
                    IWETH(address(weth)).withdraw(feeAmount);
                }
            } else {
                uint amountStableForDebt = uniV2Router.getAmountsIn(amountVolToRepay, pathStableToVol)[0];
                amountStableToRedeem = amountStableForDebt;
                address[] memory pathFee;

                if (feeAmount > 0 && !payFeeFromBal) {
                    pathFee = newPath(_tokens.stable, weth);
                    amountStableToRedeem += uniV2Router.getAmountsIn(feeAmount, pathFee)[0];
                }

                code = _tokens.cStable.redeemUnderlying(amountStableToRedeem);
                require(code == 0, string(abi.encodePacked("DNPair: fuse redeem underlying ", Strings.toString(code))));

                uniV2Router.swapTokensForExactTokens(amountVolToRepay, amountStableForDebt, pathStableToVol, address(this), block.timestamp);
                code = _tokens.cVol.repayBorrow(amountVolToRepay);
                require(code == 0, string(abi.encodePacked("DNPair: fuse repay borrow non-WETH ", Strings.toString(code))));

                if (feeAmount > 0 && !payFeeFromBal) {
                    uniV2Router.swapTokensForExactETH(feeAmount, amountStableToRedeem-amountStableForDebt, pathFee, payable(address(this)), block.timestamp);
                }
            }

        } else if (volPos.bps <= mb.min) {
            // Borrow more
            uint amountVolBorrowed = volPos.owned - volPos.debt;
            code = _tokens.cVol.borrow(amountVolBorrowed);
            require(code == 0, string(abi.encodePacked("DNPair: fuse borrow more ", Strings.toString(code))));

            // First swap everything to the stablecoin and then swap the `feeAmount` to ETH,
            // rather than swapping to ETH first, because if the volatile is WETH/ETH, then swapping
            // WETH/ETH to ETH would error in Uniswap
            uint amountStableToLend = uniV2Router.swapExactTokensForTokens(
                amountVolBorrowed,
                1,
                pathVolToStable,
                address(this),
                block.timestamp
            )[pathVolToStable.length-1];
            
            if (feeAmount > 0 && !payFeeFromBal) {
                // This 2nd swap to ETH would fail if there aren't enough stables to cover the execution
                // fee, but this is a feature not a bug - if only a small amount of tokens are being swapped,
                // then it's not worth paying for the rebalance, and it simplifies rebalancing
                amountStableToLend -= uniV2Router.swapTokensForExactETH(
                    feeAmount,
                    amountStableToLend,
                    newPath(_tokens.stable, weth),
                    payable(address(this)),
                    block.timestamp
                )[0];
            }
            
            code = _tokens.cStable.mint(amountStableToLend);
            require(code == 0, string(abi.encodePacked("DNPair: fuse more stable mint ", Strings.toString(code))));
        } else {
            require(passIfInBounds, "DNPair: debt within range");
        }

        if (feeAmount > 0) {
            payable(address(registry)).transfer(feeAmount);
        }

        volPos = _getDebtBps(_tokens);
        require(volPos.bps >= mb.min && volPos.bps <= mb.max, "DNPair: debt not within range");
    }

    function getDebtBps() public override returns (VolPosition memory) {
        return _getDebtBps(tokens);
    }

    function _getDebtBps(Tokens memory _tokens) private returns (VolPosition memory volPos) {
        volPos.owned = _tokens.vol.balanceOf(address(_tokens.uniLp)) * _tokens.cUniLp.balanceOfUnderlying(address(this)) / _tokens.uniLp.totalSupply();
        volPos.debt = _tokens.cVol.borrowBalanceCurrent(address(this));
        volPos.bps = volPos.debt * BASE_FACTOR / volPos.owned;
    }

    function setMmBps(MmBps calldata newMmBps) external override onlyOwner {
        mmBps = newMmBps;
    }

    function _mintLiquidity(
        address to,
        address feeReceiver,
        uint amountStable,
        uint amountVol,
        uint increaseFactor
    ) private returns (uint liquidityFee, uint liquidityForUser) {
        // (uint reserveStable, uint reserveVol, uint _totalSupply) = getReserves(amountStable, amountVol, amountUniLp);
        uint _totalSupply = totalSupply;
        uint liquidity;
        if (_totalSupply == 0) {
            liquidity = Maths.sqrt(amountStable * amountVol) - MINIMUM_LIQUIDITY;
           _mint(address(this), MINIMUM_LIQUIDITY); // permanently lock the first MINIMUM_LIQUIDITY tokens
        } else {
            liquidity = _totalSupply * increaseFactor / BASE_FACTOR;
        }
        require(liquidity > 0, 'DNPair: invalid liquidity mint');

        liquidityFee = liquidity * factory.depositFee() / BASE_FACTOR;
        liquidityForUser = liquidity - liquidityFee;

        _mint(feeReceiver, liquidityFee);
        _mint(to, liquidityForUser);
    }


    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////
    ////                                                          ////
    ////-------------------------Helpers--------------------------////
    ////                                                          ////
    //////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////

    function newPath(IERC20Metadata src, IERC20Metadata dest) private pure returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = address(src);
        path[1] = address(dest);
        return path;
    }

    function getTokens() external view override returns (
        IERC20Metadata stable,
        ICErc20 cStable,
        IERC20Metadata vol,
        ICErc20 cVol,
        IERC20Metadata uniLp,
        ICErc20 cUniLp
    ) {
        Tokens memory _tokens = tokens;
        return (
            _tokens.stable,
            _tokens.cStable,
            _tokens.vol,
            _tokens.cVol,
            _tokens.uniLp,
            _tokens.cUniLp
        );
    }

    receive() external payable {}
}
