# AutoHedge

Auto-Hedge is an automatically hedged DEX liquidity position. In a single tx, you:

- deposit a stablecoin and convert half of it to a volatile token, like WETH
- LP with the volatile and stablecoin on a DEX such as Uniswap
- lend out the DEX LP token and use it as collateral to borrow an equivalent amount of the volatile token
- sell that volatile token for the stablecoin, which essentially completes a short position
- lend out the stablecoin for extra yield

As time goes on, people will trade in and out of the DEX, and so the amount of each token in the pair that you own will change - this causes the debt position of the volatile token to be out of sync with the amount that's in the DEX. Autonomy automatically rebalances this every time these amounts go out of sync by 1%, by either borrowing more volatile or paying some back, depending on whether the debt is less or more than the amount of volatile in the DEX.

An AutoHedge LP token (AH-LP) is issued to the user that wraps the DEX position and all the lending/borrowing positions. By definition this asset is very low risk, and is basically like a yield-bearing stablecoin, so can be used as collateral with low collateral ratio to borrow more underlying assets (e.g. DAI+WETH) to then LP with in AutoHedge again, to get more AH-LP tokens, to use as collteral to borrow with again etc. In this way, you can 10x leverage the amount of assets you're LPing with, but with very low risk as your borrowing position is by definition always 2x overcollateralised. So if a DEX pair has 10% APY, you can get 100% APY by leverage LPing.

## How to run tests

```shell
yarn fork https://eth-mainnet.alchemyapi.io/v2/{API_KEY} [in terminal 1]
yarn fuse [in terminal 2]
yarn test [in terminal 2]
```
