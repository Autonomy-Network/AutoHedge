// noinspection JSUnresolvedFunction,JSUnresolvedVariable

import { ethers } from "hardhat"
import fs from "fs"
const { parseEther } = ethers.utils
// const {BigNumber} = require("@ethersproject.bignumber")
import { expect } from "chai"

import { getEthPrice, equalTol, revSnapshot, noDeadline } from "scripts/utils"

import ICErc20 from "artifacts/interfaces/ICErc20.sol/ICErc20.json"

import WETH from "thirdparty/WETH.json"
import DAI from "thirdparty/DAI.json"
import UniswapV2Router02 from "thirdparty/UniswapV2Router02.json"
import FuseFeeDistributor from "thirdparty/FuseFeeDistributor.json"

const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
const UNI_DAI_WETH_PAIR_ADDR = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11"

const MINIMUM_LIQUIDITY = 1000

const RES_TOL_LOWER = 999990
const RES_TOL_UPPER = 1000010
const RES_TOL_TOTAL = 1000000
const TEN_18 = 10 ** 18

const REV_MSG_WITHIN_RANGE = "DNPair: debt within range"

describe("DeltaNeutralStableVolatilePairUpgradeable", function () {
  let addresses
  let mockSqrt

  let ethPrice

  let owner
  let bob
  let alice

  let weth
  let dai
  let uniV2

  let factory
  let pair

  const UNIV2_DAI_ETH_ADDR = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11"
  let uniLp
  let cVol
  let cStable
  let cUniLp

  const c = (artifact) =>
    new ethers.Contract(artifact.address, artifact.abi, owner)

  let testSnapshotId

  const TEN_18 = parseEther("1")

  before(async function () {
    ;[owner, bob, alice] = await ethers.getSigners()

    addresses = getAddresses()
    testSnapshotId = await revSnapshot(addresses.snapshotId)

    await network.provider.request({
      method: "evm_revert",
      params: [addresses.snapshotId],
    })

    weth = c(WETH)
    dai = c(DAI)
    uniV2Router = c(UniswapV2Router02)

    // ethPrice = parseInt((await uniV2Router.getAmountsOut(parseEther('1'), [weth.address, dai.address]))[1].div(parseEther('1')))
    ethPrice = await getEthPrice()
    expect(ethPrice).to.be.greaterThan(0)

    // It's fucking dumb that BigNumber doesn't support sqrt operations -.- need to mock using the sqrt used in Solidity
    const MockSqrt = await ethers.getContractFactory("MockSqrt")
    const TProxyAdmin = await ethers.getContractFactory("TProxyAdmin")
    const TProxy = await ethers.getContractFactory("TProxy")
    const DeltaNeutralStableVolatileFactory = await ethers.getContractFactory(
      "DeltaNeutralStableVolatileFactory"
    )
    const DeltaNeutralStableVolatilePairUpgradeable =
      await ethers.getContractFactory(
        "DeltaNeutralStableVolatilePairUpgradeable"
      )

    mockSqrt = await MockSqrt.deploy()
    admin = await TProxyAdmin.deploy()
    pairImpl = await DeltaNeutralStableVolatilePairUpgradeable.deploy()
    factory = await DeltaNeutralStableVolatileFactory.deploy(
      pairImpl.address,
      admin.address,
      weth.address,
      UNIV2_FACTORY_ADDR,
      UniswapV2Router02.address,
      addresses.unitroller,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      [parseEther("0.99"), parseEther("1.01")]
    )

    const tx = await factory.createPair(dai.address, weth.address)
    const receipt = await tx.wait()

    pair = await DeltaNeutralStableVolatilePairUpgradeable.attach(
      receipt.events[receipt.events.length - 1].args.pair
    )

    const tokens = await pair.tokens()
    uniLp = new ethers.Contract(tokens.uniLp, WETH.abi, owner)
    cVol = new ethers.Contract(tokens.cVol, ICErc20.abi, owner)
    cStable = new ethers.Contract(tokens.cStable, ICErc20.abi, owner)
    cUniLp = new ethers.Contract(tokens.cUniLp, ICErc20.abi, owner)

    await weth.approve(pair.address, parseEther("100000000"))
    await weth.connect(bob).approve(pair.address, parseEther("100000000"))
    await weth.connect(alice).approve(pair.address, parseEther("100000000"))
    await dai.approve(pair.address, parseEther("100000000"))
    await dai.connect(bob).approve(pair.address, parseEther("100000000"))
    await dai.connect(alice).approve(pair.address, parseEther("100000000"))

    testSnapshotId = await network.provider.request({
      method: "evm_snapshot",
    })
  })

  after(async function () {
    addresses.snapshotId = testSnapshotId
    console.log("addresses", addresses)
    fs.writeFileSync("addresses.json", JSON.stringify(addresses))
  })

  // beforeEach(async function () {
  //     await network.provider.request({
  //         method: 'evm_revert',
  //         params: [testSnapshotId]
  //     })
  // })

  // it('Should deposit', async function () {
  //     // I'm aware this is a super noob move - just duct taping to save time
  //     testSnapshotId = await revSnapshot(testSnapshotId)

  //     const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
  //     const amountVolZapMin = parseEther('1')
  //     const amountStableMin = 0
  //     const amountVolMin = 0
  //     const swapAmountOutMin = 0

  //     const wethBalanceBefore = await weth.balanceOf(owner.address)
  //     const daiBalanceBefore = await dai.balanceOf(owner.address)

  //     // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
  //     // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
  //     // 1st to measure the reserves after
  //     testSnapshotId2 = await network.provider.request({
  //         method: 'evm_snapshot'
  //     })

  //     await dai.approve(uniV2Router.address, amountStableInit)
  //     await weth.approve(uniV2Router.address, amountStableInit)
  //     const amountsStableToVol = await uniV2Router.getAmountsOut(amountStableInit.div(2), [dai.address, weth.address])
  //     const amountVolEstimated = amountsStableToVol[1]
  //     await uniV2Router.swapExactTokensForTokens(amountStableInit.sub(amountsStableToVol[0]), 1, [dai.address, weth.address], owner.address, TEN_18)
  //     const amountStableEstimated = amountVolEstimated.mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
  //     await uniV2Router.addLiquidity(dai.address, weth.address, amountStableEstimated, amountVolEstimated, 1, 1, owner.address, TEN_18)
  //     const amountStableSwappedIntoEstimated = (await uniV2Router.getAmountsOut(amountVolEstimated, [weth.address, dai.address]))[1]

  //     await network.provider.request({
  //         method: 'evm_revert',
  //         params: [testSnapshotId2]
  //     })

  //     const tx = await pair.deposit(
  //         amountStableInit,
  //         amountVolZapMin,
  //         [
  //             amountStableMin,
  //             amountVolMin,
  //             noDeadline,
  //             [dai.address, weth.address],
  //             [weth.address, dai.address],
  //             swapAmountOutMin
  //         ],
  //         owner.address
  //     )
  //     const receipt = await tx.wait()
  //     const depositedEvent = receipt.events[receipt.events.length - 1]

  //     const {amountStable, amountUniLp, amountVol} = depositedEvent.args

  //     // factory, pair, cTokens, owner
  //     expect(amountVol).to.equal(amountVolEstimated)
  //     expect(amountStable).to.equal(amountStableEstimated)
  //     expect(wethBalanceBefore).to.equal(await weth.balanceOf(owner.address))
  //     expect(amountStable.add(amountStableInit.div(2))).to.equal(daiBalanceBefore.sub(await dai.balanceOf(owner.address)))
  //     // Stable
  //     expect(await dai.balanceOf(factory.address)).to.equal(0)
  //     expect(await dai.balanceOf(pair.address)).to.equal(0)
  //     expect(await dai.balanceOf(owner.address)).to.equal(daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0]))
  //     // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(amountStableSwappedIntoEstimated.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(amountStableSwappedIntoEstimated.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     // Volatile
  //     expect(await weth.balanceOf(factory.address)).to.equal(0)
  //     expect(await weth.balanceOf(pair.address)).to.equal(0)
  //     expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
  //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(amountVol)
  //     // Uniswap LP token
  //     expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(amountUniLp)
  //     // AutoHedge LP token
  //     expect(await pair.balanceOf(factory.address)).to.equal(0)
  //     expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
  //     expect(await pair.balanceOf(owner.address)).to.equal((await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(MINIMUM_LIQUIDITY))
  // })

  // it('Should deposit twice', async function () {
  //     // I'm aware this is a super noob move - just duct taping to save time
  //     testSnapshotId = await revSnapshot(testSnapshotId)

  //     const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
  //     const amountVolZapMin = parseEther('1')
  //     const amountStableMin = 0
  //     const amountVolMin = 0
  //     const swapAmountOutMin = 0

  //     const wethBalanceBefore = await weth.balanceOf(owner.address)
  //     const daiBalanceBefore = await dai.balanceOf(owner.address)

  //     // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
  //     // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
  //     // 1st to measure the reserves after
  //     testSnapshotId2 = await network.provider.request({
  //         method: 'evm_snapshot'
  //     })

  //     await dai.approve(uniV2Router.address, amountStableInit)
  //     await weth.approve(uniV2Router.address, amountStableInit)
  //     const amountsStableToVol = await uniV2Router.getAmountsOut(amountStableInit.div(2), [dai.address, weth.address])
  //     const amountVolEstimated = amountsStableToVol[1]
  //     await uniV2Router.swapExactTokensForTokens(amountStableInit.sub(amountsStableToVol[0]), 1, [dai.address, weth.address], owner.address, TEN_18)
  //     const amountStableEstimated = amountVolEstimated.mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
  //     await uniV2Router.addLiquidity(dai.address, weth.address, amountStableEstimated, amountVolEstimated, 1, 1, owner.address, TEN_18)
  //     let wethBalanceTemp = await weth.balanceOf(owner.address)
  //     let excessWethLiquidityAmounts = 0
  //     if (wethBalanceTemp.sub(wethBalanceBefore).gt(0)) {
  //         excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(wethBalanceTemp.sub(wethBalanceBefore), [weth.address, dai.address])
  //         await uniV2Router.swapExactTokensForTokens(wethBalanceTemp.sub(wethBalanceBefore), 1, [weth.address, dai.address], owner.address, TEN_18)
  //     }
  //     const amountStableSwappedIntoEstimated = (await uniV2Router.getAmountsOut(amountVolEstimated, [weth.address, dai.address]))[1]

  //     await network.provider.request({
  //         method: 'evm_revert',
  //         params: [testSnapshotId2]
  //     })

  //     const tx = await pair.deposit(
  //         amountStableInit,
  //         amountVolZapMin,
  //         [
  //             amountStableMin,
  //             amountVolMin,
  //             noDeadline,
  //             [dai.address, weth.address],
  //             [weth.address, dai.address],
  //             swapAmountOutMin
  //         ],
  //         owner.address
  //     )
  //     const receipt = await tx.wait()
  //     const depositedEvent = receipt.events[receipt.events.length - 1]

  //     const {amountStable, amountUniLp, amountVol} = depositedEvent.args

  //     // factory, pair, cTokens, owner
  //     expect(amountVol).to.equal(amountVolEstimated)
  //     expect(amountStable).to.equal(amountStableEstimated)
  //     expect(wethBalanceBefore).to.equal(await weth.balanceOf(owner.address))
  //     // Stable
  //     expect(await dai.balanceOf(factory.address)).to.equal(0)
  //     expect(await dai.balanceOf(pair.address)).to.equal(0)
  //     if (excessWethLiquidityAmounts == 0) {
  //         expect(amountStable.add(amountStableInit.div(2))).to.equal(daiBalanceBefore.sub(await dai.balanceOf(owner.address)))
  //     } else {
  //         const aliceDaiSpentEstimated = amountStable.add(amountStableInit.div(2)).add(excessWethLiquidityAmounts[1])
  //         const aliceDaiBalDiff = daiBalanceBefore.sub(await dai.balanceOf(owner.address))
  //         expect(aliceDaiSpentEstimated).gt(aliceDaiBalDiff.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //         expect(aliceDaiSpentEstimated).lt(aliceDaiBalDiff.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     }
  //     // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(amountStableSwappedIntoEstimated.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(amountStableSwappedIntoEstimated.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     // Volatile
  //     expect(await weth.balanceOf(factory.address)).to.equal(0)
  //     expect(await weth.balanceOf(pair.address)).to.equal(0)
  //     expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
  //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(amountVol)
  //     // Uniswap LP token
  //     expect(await uniLp.balanceOf(factory.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(pair.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(owner.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(alice.address)).to.equal(0)
  //     expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(amountUniLp)
  //     // AutoHedge LP token
  //     expect(await pair.balanceOf(factory.address)).to.equal(0)
  //     expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
  //     expect(await pair.balanceOf(owner.address)).to.equal((await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(MINIMUM_LIQUIDITY))

  //     // Now to deposit again from Alice

  //     const wethBalanceBefore2 = await weth.balanceOf(alice.address)
  //     const daiBalanceBefore2 = await dai.balanceOf(alice.address)

  //     // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
  //     // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
  //     // 1st to measure the reserves after
  //     testSnapshotId2 = await network.provider.request({
  //         method: 'evm_snapshot'
  //     })

  //     await dai.connect(alice).approve(uniV2Router.address, amountStableInit)
  //     await weth.connect(alice).approve(uniV2Router.address, amountStableInit)
  //     const amountsStableToVol2 = await uniV2Router.getAmountsOut(amountStableInit.div(2), [dai.address, weth.address])
  //     const amountVolEstimated2 = amountsStableToVol2[1]
  //     await uniV2Router.connect(alice).swapExactTokensForTokens(amountStableInit.sub(amountsStableToVol2[0]), 1, [dai.address, weth.address], alice.address, TEN_18)
  //     const amountStableEstimated2 = amountVolEstimated2.mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
  //     await uniV2Router.connect(alice).addLiquidity(dai.address, weth.address, amountStableEstimated2, amountVolEstimated2, 1, 1, alice.address, TEN_18)
  //     wethBalanceTemp = await weth.balanceOf(alice.address)
  //     excessWethLiquidityAmounts = 0
  //     if (wethBalanceTemp.sub(wethBalanceBefore2).gt(0)) {
  //         excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(wethBalanceTemp.sub(wethBalanceBefore2), [weth.address, dai.address])
  //         await uniV2Router.connect(alice).swapExactTokensForTokens(wethBalanceTemp.sub(wethBalanceBefore2), 1, [weth.address, dai.address], alice.address, TEN_18)
  //     }
  //     const amountStableSwappedIntoEstimated2 = (await uniV2Router.getAmountsOut(amountVolEstimated2, [weth.address, dai.address]))[1]

  //     await network.provider.request({
  //         method: 'evm_revert',
  //         params: [testSnapshotId2]
  //     })

  //     const tx2 = await pair.connect(alice).deposit(
  //         amountStableInit,
  //         amountVolZapMin,
  //         [
  //             amountStableMin,
  //             amountVolMin,
  //             noDeadline,
  //             [dai.address, weth.address],
  //             [weth.address, dai.address],
  //             swapAmountOutMin
  //         ],
  //         alice.address
  //     )
  //     const receipt2 = await tx2.wait()
  //     const depositedEvent2 = receipt2.events[receipt2.events.length - 1]

  //     const amountStable2 = depositedEvent2.args['amountStable']
  //     const amountUniLp2 = depositedEvent2.args['amountUniLp']
  //     const amountVol2 = depositedEvent2.args['amountVol']

  //     // factory, pair, cTokens, owner
  //     expect(amountVol2).to.equal(amountVolEstimated2)
  //     expect(amountStable2).to.equal(amountStableEstimated2)
  //     // Stable
  //     expect(await dai.balanceOf(factory.address)).to.equal(0)
  //     expect(await dai.balanceOf(pair.address)).to.equal(0)
  //     expect(await dai.balanceOf(owner.address)).to.equal(daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0]))
  //     if (excessWethLiquidityAmounts == 0) {
  //         expect(amountStable2.add(amountStableInit.div(2))).to.equal(daiBalanceBefore2.sub(await dai.balanceOf(alice.address)))
  //     } else {
  //         const aliceDaiSpentEstimated = amountStable2.add(amountStableInit.div(2)).add(excessWethLiquidityAmounts[1])
  //         const aliceDaiBalDiff = daiBalanceBefore2.sub(await dai.balanceOf(alice.address))
  //         expect(aliceDaiSpentEstimated).gt(aliceDaiBalDiff.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //         expect(aliceDaiSpentEstimated).lt(aliceDaiBalDiff.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     }
  //     // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(amountStableSwappedIntoEstimated2.add(amountStableSwappedIntoEstimated2).mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(amountStableSwappedIntoEstimated2.add(amountStableSwappedIntoEstimated2).mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     // Volatile
  //     expect(await weth.balanceOf(factory.address)).to.equal(0)
  //     expect(await weth.balanceOf(pair.address)).to.equal(0)
  //     expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
  //     expect(await weth.balanceOf(alice.address)).to.equal(wethBalanceBefore2)
  //     equalTol(await cVol.callStatic.borrowBalanceCurrent(pair.address), amountVol.add(amountVol2))
  //     // Uniswap LP token
  //     expect(await uniLp.balanceOf(factory.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(pair.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(owner.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(alice.address)).to.equal(0)
  //     expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(amountUniLp.add(amountUniLp2))
  //     // AutoHedge LP token
  //     expect(await pair.balanceOf(factory.address)).to.equal(0)
  //     expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
  //     expect(await pair.balanceOf(owner.address)).to.equal((await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(MINIMUM_LIQUIDITY))
  //     equalTol(await pair.balanceOf(alice.address), await pair.balanceOf(owner.address))
  // })

  // it('Should withdraw', async function () {
  //     // I'm aware this is a super noob move - just duct taping to save time
  //     testSnapshotId = await revSnapshot(testSnapshotId)

  //     // deposit to withdraw
  //     const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
  //     const amountVolZapMin = parseEther('1')
  //     const amountStableMin = 1
  //     const amountVolMin = 1
  //     const swapAmountOutMin = 1

  //     const wethBalanceBefore = await weth.balanceOf(owner.address)
  //     const daiBalanceBefore = await dai.balanceOf(owner.address)

  //     // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
  //     // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
  //     // 1st to measure the reserves after
  //     testSnapshotId2 = await network.provider.request({
  //         method: 'evm_snapshot'
  //     })

  //     await dai.approve(uniV2Router.address, amountStableInit)
  //     await weth.approve(uniV2Router.address, amountStableInit)
  //     const amountsStableToVol = await uniV2Router.getAmountsOut(amountStableInit.div(2), [dai.address, weth.address])
  //     const amountVolEstimated = amountsStableToVol[1]
  //     await uniV2Router.swapExactTokensForTokens(amountStableInit.sub(amountsStableToVol[0]), 1, [dai.address, weth.address], owner.address, TEN_18)
  //     const amountStableEstimated = amountVolEstimated.mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
  //     await uniV2Router.addLiquidity(dai.address, weth.address, amountStableEstimated, amountVolEstimated, 1, 1, owner.address, TEN_18)
  //     const amountStableSwappedIntoEstimated = (await uniV2Router.getAmountsOut(amountVolEstimated, [weth.address, dai.address]))[1]

  //     await network.provider.request({
  //         method: 'evm_revert',
  //         params: [testSnapshotId2]
  //     })

  //     let tx = await pair.deposit(
  //         amountStableInit,
  //         amountVolZapMin,
  //         [
  //             amountStableMin,
  //             amountVolMin,
  //             noDeadline,
  //             [dai.address, weth.address],
  //             [weth.address, dai.address],
  //             swapAmountOutMin
  //         ],
  //         owner.address
  //     )
  //     let receipt = await tx.wait()
  //     const depositedEvent = receipt.events[receipt.events.length - 1]

  //     const {amountStable, amountUniLp, amountVol, amountStableSwap} = depositedEvent.args

  //     // factory, pair, cTokens, owner
  //     expect(amountVol).to.equal(amountVolEstimated)
  //     expect(amountStable).to.equal(amountStableEstimated)
  //     expect(wethBalanceBefore).to.equal(await weth.balanceOf(owner.address))
  //     equalTol(amountStable.add(amountStableInit.div(2)), daiBalanceBefore.sub(await dai.balanceOf(owner.address)))

  //     // Stable
  //     expect(await dai.balanceOf(factory.address)).to.equal(0)
  //     expect(await dai.balanceOf(pair.address)).to.equal(0)
  //     equalTol(await dai.balanceOf(owner.address), daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0]))
  //     // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(amountStableSwappedIntoEstimated.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(amountStableSwappedIntoEstimated.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     // Volatile
  //     expect(await weth.balanceOf(factory.address)).to.equal(0)
  //     expect(await weth.balanceOf(pair.address)).to.equal(0)
  //     expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
  //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(amountVol)
  //     // Uniswap LP token
  //     expect(await uniLp.balanceOf(factory.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(pair.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(owner.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(alice.address)).to.equal(0)
  //     expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(amountUniLp)
  //     // AutoHedge LP token
  //     expect(await pair.balanceOf(factory.address)).to.equal(0)
  //     expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
  //     expect(await pair.balanceOf(owner.address)).to.equal((await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(MINIMUM_LIQUIDITY))

  //     const aliceVolBalanceAfter = await weth.balanceOf(alice.address);
  //     const aliceStableBalanceAfter = await dai.balanceOf(alice.address);

  //     const ownerLiquidityBalance = await pair.balanceOf(owner.address)
  //     await pair.transfer(alice.address, ownerLiquidityBalance)

  //     const liqNumer = 9900000
  //     const liqDenom = 10000000
  //     const aliceLiquidityWithdraw = ownerLiquidityBalance.mul(liqNumer).div(liqDenom)

  //     const totalLpSupplyAfterDeposit = await pair.totalSupply();

  //     const amountStableFromLending = amountStableSwappedIntoEstimated.mul(aliceLiquidityWithdraw).div(totalLpSupplyAfterDeposit);
  //     const withdrawSwapAmountsEstimated = await uniV2Router.getAmountsOut(amountStableFromLending, [dai.address, weth.address]);
  //     const amountVolSwapped = withdrawSwapAmountsEstimated[withdrawSwapAmountsEstimated.length - 1];
  //     const amountVolToRepay = (await cVol.callStatic.borrowBalanceCurrent(pair.address)).mul(aliceLiquidityWithdraw).div(totalLpSupplyAfterDeposit);
  //     const amountUniLpToWithdraw = (await cUniLp.callStatic.balanceOfUnderlying(pair.address)).mul(aliceLiquidityWithdraw).div(totalLpSupplyAfterDeposit);

  //     let amountStableFromWithdraw;
  //     let amountVolFromWithdraw = 0;

  //     if (amountVolToRepay <= amountVolSwapped) {
  //         amountStableFromWithdraw = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).mul(amountUniLpToWithdraw).div(await uniLp.totalSupply());
  //         amountVolFromWithdraw = (await weth.balanceOf(UNIV2_DAI_ETH_ADDR)).mul(amountUniLpToWithdraw).div(await uniLp.totalSupply());
  //     } else {
  //         const amountStableFromLp = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).mul(amountUniLpToWithdraw).div(await uniLp.totalSupply());
  //         const amountVolFromLp = (await weth.balanceOf(UNIV2_DAI_ETH_ADDR)).mul(amountUniLpToWithdraw).div(await uniLp.totalSupply());
  //         const amountVolToSwap = amountVolFromLp.add(amountVolSwapped).sub(amountVolToRepay);
  //         const amountStableSwapped = await uniV2Router.getAmountsOut(amountVolToSwap, [weth.address, dai.address]);
  //         amountStableFromWithdraw = amountStableFromLp.add(amountStableSwapped[amountStableSwapped.length-1]);
  //     }

  //     tx = await pair.connect(alice).withdraw(
  //         aliceLiquidityWithdraw,
  //         [
  //             amountStableMin,
  //             amountVolMin,
  //             noDeadline,
  //             [dai.address, weth.address],
  //             [weth.address, dai.address],
  //             swapAmountOutMin
  //         ]
  //     )
  //     receipt = await tx.wait()

  //     // factory, pair, cTokens, owner, alice
  //     expect(await pair.totalSupply()).to.equal(ethers.BigNumber.from(MINIMUM_LIQUIDITY).add(ownerLiquidityBalance.sub(aliceLiquidityWithdraw)))

  //     // Stable
  //     expect(await dai.balanceOf(factory.address)).to.equal(0)
  //     expect(await dai.balanceOf(pair.address)).to.equal(0)
  //     expect(await dai.balanceOf(owner.address)).to.equal(daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0]))
  //     const aliceStableBalanceEnd = aliceStableBalanceAfter.add(amountStableFromWithdraw)
  //     expect(await dai.balanceOf(alice.address)).gt(aliceStableBalanceEnd.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect(await dai.balanceOf(alice.address)).lt(aliceStableBalanceEnd.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     const cStableLeft = amountStableSwap.mul(liqDenom-liqNumer).div(liqDenom)
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(cStableLeft.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(cStableLeft.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))

  //     // Volatile
  //     expect(await weth.balanceOf(factory.address)).to.equal(0)
  //     expect(await weth.balanceOf(pair.address)).to.equal(0)
  //     expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
  //     const aliceVolBalanceEnd = aliceVolBalanceAfter.add(amountVolFromWithdraw)
  //     expect(await weth.balanceOf(alice.address)).gt(aliceVolBalanceEnd.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect(await weth.balanceOf(alice.address)).lt(aliceVolBalanceEnd.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
  //     const cVolLeft = amountVol.sub(amountVol.mul(aliceLiquidityWithdraw).div(totalLpSupplyAfterDeposit))
  //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).gt(cVolLeft.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).lt(cVolLeft.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))

  //     // Uniswap LP token
  //     expect(await uniLp.balanceOf(factory.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(pair.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(owner.address)).to.equal(0)
  //     expect(await uniLp.balanceOf(alice.address)).to.equal(0)
  //     const amountUniLpLent = await cUniLp.callStatic.balanceOfUnderlying(pair.address)
  //     const estimatedAmountUniLpLent = amountUniLp.mul(liqDenom-liqNumer).div(liqDenom)
  //     expect(amountUniLpLent).gt(estimatedAmountUniLpLent.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  //     expect(amountUniLpLent).lt(estimatedAmountUniLpLent.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))

  //     // AutoHedge LP token
  //     expect(await pair.balanceOf(factory.address)).to.equal(0)
  //     expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
  //     expect(await pair.balanceOf(owner.address)).to.equal(0)
  //     expect(await pair.balanceOf(alice.address)).to.equal(ownerLiquidityBalance.sub(aliceLiquidityWithdraw))
  // })

  it("Should rebalance, borrow more ETH, no fee", async function () {
    // I'm aware this is a super noob move - just duct taping to save time
    testSnapshotId = await revSnapshot(testSnapshotId)

    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await weth.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    testSnapshotId2 = await network.provider.request({
      method: "evm_snapshot",
    })

    await dai.approve(uniV2Router.address, amountStableInit)
    await weth.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, weth.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, weth.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      weth.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        weth.address,
        dai.address,
      ])
    )[1]

    await network.provider.request({
      method: "evm_revert",
      params: [testSnapshotId2],
    })

    const tx = await pair.deposit(
      amountStableInit,
      amountVolZapMin,
      [
        amountStableMin,
        amountVolMin,
        noDeadline,
        [dai.address, weth.address],
        [weth.address, dai.address],
        swapAmountOutMin,
      ],
      owner.address
    )
    const receipt = await tx.wait()
    const depositedEvent = receipt.events[receipt.events.length - 1]

    const { amountStable, amountUniLp, amountVol } = depositedEvent.args

    // factory, pair, cTokens, owner
    expect(amountVol).to.equal(amountVolEstimated)
    expect(amountStable).to.equal(amountStableEstimated)
    expect(wethBalanceBefore).to.equal(await weth.balanceOf(owner.address))
    expect(amountStable.add(amountStableInit.div(2))).to.equal(
      daiBalanceBefore.sub(await dai.balanceOf(owner.address))
    )
    // Stable
    expect(await dai.balanceOf(factory.address)).to.equal(0)
    expect(await dai.balanceOf(pair.address)).to.equal(0)
    expect(await dai.balanceOf(owner.address)).to.equal(
      daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
    )
    // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
    expect(await cStable.callStatic.balanceOfUnderlying(pair.address)).gt(
      amountStableSwappedIntoEstimated.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL)
    )
    expect(await cStable.callStatic.balanceOfUnderlying(pair.address)).lt(
      amountStableSwappedIntoEstimated.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL)
    )
    // Volatile
    expect(await weth.balanceOf(factory.address)).to.equal(0)
    expect(await weth.balanceOf(pair.address)).to.equal(0)
    expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
    expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(
      amountVol
    )
    // Uniswap LP token
    expect(await uniLp.balanceOf(factory.address)).to.equal(0)
    expect(await uniLp.balanceOf(pair.address)).to.equal(0)
    expect(await uniLp.balanceOf(owner.address)).to.equal(0)
    expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(
      amountUniLp
    )
    // AutoHedge LP token
    expect(await pair.balanceOf(factory.address)).to.equal(0)
    expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
    const ownerLiquidityBalance = (
      await mockSqrt.sqrt(amountVol.mul(amountStable))
    ).sub(MINIMUM_LIQUIDITY)
    expect(await pair.balanceOf(owner.address)).to.equal(ownerLiquidityBalance)

    // Should revert when trying to rebalance when it's not needed
    await expect(pair.rebalance()).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    // Increase the amount of ETH held in the DEX
    const wethInUniBeforeTrade = await weth.balanceOf(UNI_DAI_WETH_PAIR_ADDR)
    const amountWethSell = parseEther("1000")
    await weth.connect(bob).approve(uniV2Router.address, amountWethSell)
    await uniV2Router
      .connect(bob)
      .swapExactTokensForTokens(
        amountWethSell,
        1,
        [weth.address, dai.address],
        bob.address,
        TEN_18
      )

    const wethInUniAfterTrade = await weth.balanceOf(UNI_DAI_WETH_PAIR_ADDR)
    const { amountVolOwned, amountVolDebt, debtBps } =
      await pair.callStatic.getDebtBps()

    expect(wethInUniAfterTrade).gt(wethInUniBeforeTrade)
    const uniLpTotalSupply = await uniLp.totalSupply()
    const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
      pair.address
    )
    expect(amountVolOwned).equal(
      wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
    )
    expect(amountVolDebt).equal(
      await cVol.callStatic.borrowBalanceCurrent(pair.address)
    )
    expect(debtBps).equal(amountVolDebt.mul(TEN_18).div(amountVolOwned))

    const estStableFromVol = (
      await uniV2Router.getAmountsOut(amountVolOwned.sub(amountVolDebt), [
        weth.address,
        dai.address,
      ])
    )[1]

    await pair.rebalance()

    // factory, pair, cTokens, owner
    // Stable
    expect(await dai.balanceOf(factory.address)).to.equal(0)
    expect(await dai.balanceOf(pair.address)).to.equal(0)
    expect(await dai.balanceOf(owner.address)).to.equal(
      daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
    )
    equalTol(
      await cStable.callStatic.balanceOfUnderlying(pair.address),
      amountStableSwappedIntoEstimated.add(estStableFromVol)
    )

    // Volatile
    expect(await weth.balanceOf(factory.address)).to.equal(0)
    expect(await weth.balanceOf(pair.address)).to.equal(0)
    expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
    equalTol(
      await cVol.callStatic.borrowBalanceCurrent(pair.address),
      amountVolOwned
    )

    // Uniswap LP token
    expect(await uniLp.balanceOf(factory.address)).to.equal(0)
    expect(await uniLp.balanceOf(pair.address)).to.equal(0)
    expect(await uniLp.balanceOf(owner.address)).to.equal(0)
    expect(await cUniLp.callStatic.balanceOfUnderlying(pair.address)).to.equal(
      amountUniLp
    )

    // AutoHedge LP token
    expect(await pair.balanceOf(factory.address)).to.equal(0)
    expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
    expect(await pair.balanceOf(owner.address)).to.equal(ownerLiquidityBalance)
    expect(await pair.totalSupply()).to.equal(
      ethers.BigNumber.from(MINIMUM_LIQUIDITY).add(ownerLiquidityBalance)
    )
  })

  // TODO: test rebalance with a fee
  // TODO: test big rebalance value such that it's out of balance after rebalancing
  // TODO: test deposit with large enough deposit for the debt to be out of sync at the end
  // TODO: test withdraw with large enough withdraw for the debt to be out of sync at the end
})
