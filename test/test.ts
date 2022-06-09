import { ethers, network } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { UniswapV2Router02, WETH } from "typechain/thirdparty"
import {
  DeltaNeutralStableVolatileFactory,
  DeltaNeutralStableVolatilePairUpgradeable,
  ICErc20,
  IERC20,
  MockSqrt,
  TProxyAdmin,
} from "typechain"

import {
  getEthPrice,
  equalTol,
  noDeadline,
  getAddresses,
  ArtifactType,
  UnitrollerSnapshot,
  snapshot,
  revertSnapshot,
} from "../scripts/utils"

import ICErc20Abi from "../artifacts/interfaces/ICErc20.sol/ICErc20.json"

import WETHAbi from "../thirdparty/WETH.json"
import DAI from "../thirdparty/DAI.json"
import UniswapV2Router02Abi from "../thirdparty/UniswapV2Router02.json"
import FuseFeeDistributorAbi from "../thirdparty/FuseFeeDistributor.json"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, constants, Event, utils } from "ethers"

const { parseEther, formatEther } = ethers.utils

const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"

const MINIMUM_LIQUIDITY = 1000

const RES_TOL_LOWER = 999990
const RES_TOL_UPPER = 1000010
const RES_TOL_TOTAL = 1000000
const TEN_18 = 10 ** 18

const REV_MSG_WITHIN_RANGE = "DNPair: debt within range"

const defaultDepositEvent = {
  amountStable: BigNumber.from(0),
  amountUniLp: BigNumber.from(0),
  amountVol: BigNumber.from(0),
}

const defaultWithdrawnEvent = {
  amountStableFromLending: BigNumber.from(0),
  amountVolToRepay: BigNumber.from(0),
  liquidity: BigNumber.from(0),
}

describe("DeltaNeutralStableVolatilePairUpgradeable", () => {
  let addresses: UnitrollerSnapshot
  let mockSqrt: MockSqrt

  let ethPrice: number

  let owner: SignerWithAddress
  let bob: SignerWithAddress
  let alice: SignerWithAddress
  let priceCoordinator: SignerWithAddress

  let weth: WETH
  let dai: IERC20
  let uniV2Router: UniswapV2Router02

  let factory: DeltaNeutralStableVolatileFactory
  let pair: DeltaNeutralStableVolatilePairUpgradeable

  const UNIV2_DAI_ETH_ADDR = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11"
  let uniLp: IERC20
  let cVol: ICErc20
  let cStable: ICErc20
  let cUniLp: ICErc20

  const c = (artifact: ArtifactType) =>
    new ethers.Contract(artifact.address, artifact.abi, owner)

  let testSnapshotId: string

  let admin: TProxyAdmin
  let pairImpl: DeltaNeutralStableVolatilePairUpgradeable

  const TEN_18 = parseEther("1")

  async function getWETHPrice() {
    return +formatEther(
      (
        await uniV2Router.getAmountsOut(parseEther("1"), [
          weth.address,
          dai.address,
        ])
      )[1]
    )
  }

  before(async () => {
    ;[owner, bob, alice, priceCoordinator] = await ethers.getSigners()

    addresses = getAddresses()

    weth = <WETH>c(WETHAbi)
    dai = <IERC20>c(DAI)
    uniV2Router = <UniswapV2Router02>c(UniswapV2Router02Abi)

    // ethPrice = parseInt((await uniV2Router.getAmountsOut(parseEther('1'), [weth.address, dai.address]))[1].div(parseEther('1')))
    ethPrice = await getEthPrice()
    expect(ethPrice).to.be.greaterThan(0)

    // It's fucking dumb that BigNumber doesn't support sqrt operations -.- need to mock using the sqrt used in Solidity
    const MockSqrtFactory = await ethers.getContractFactory("MockSqrt")
    const TProxyAdminFactory = await ethers.getContractFactory("TProxyAdmin")
    const TProxy = await ethers.getContractFactory("TProxy")
    const DeltaNeutralStableVolatileFactory = await ethers.getContractFactory(
      "DeltaNeutralStableVolatileFactory"
    )
    const DeltaNeutralStableVolatilePairUpgradeableFactory =
      await ethers.getContractFactory(
        "DeltaNeutralStableVolatilePairUpgradeable"
      )

    mockSqrt = <MockSqrt>await MockSqrtFactory.deploy()
    admin = <TProxyAdmin>await TProxyAdminFactory.deploy()
    pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
    )
    factory = <DeltaNeutralStableVolatileFactory>(
      await DeltaNeutralStableVolatileFactory.deploy(
        pairImpl.address,
        admin.address,
        weth.address,
        UNIV2_FACTORY_ADDR,
        UniswapV2Router02Abi.address,
        addresses.unitroller,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        {
          min: parseEther("0.99"),
          max: parseEther("1.01"),
        }
      )
    )

    const tx = await factory.createPair(dai.address, weth.address)
    const receipt = await tx.wait()
    const lastEvent = receipt.events?.pop()
    const pairAddress = lastEvent ? lastEvent.args?.pair : ""

    pair = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.attach(pairAddress)
    )

    const tokens = await pair.tokens()
    uniLp = <IERC20>new ethers.Contract(tokens.uniLp, WETHAbi.abi, owner)
    cVol = <ICErc20>new ethers.Contract(tokens.cVol, ICErc20Abi.abi, owner)
    cStable = <ICErc20>(
      new ethers.Contract(tokens.cStable, ICErc20Abi.abi, owner)
    )
    cUniLp = <ICErc20>new ethers.Contract(tokens.cUniLp, ICErc20Abi.abi, owner)

    await weth.approve(pair.address, constants.MaxUint256)
    await weth.connect(bob).approve(pair.address, constants.MaxUint256)
    await weth.connect(alice).approve(pair.address, constants.MaxUint256)
    await dai.approve(pair.address, constants.MaxUint256)
    await dai.connect(bob).approve(pair.address, constants.MaxUint256)
    await dai.connect(alice).approve(pair.address, constants.MaxUint256)
  })

  beforeEach(async () => {
    testSnapshotId = await snapshot()
  })

  afterEach(async () => {
    await revertSnapshot(testSnapshotId)
  })

  describe("deposit()", () => {
    it("Should deposit", async function () {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await weth.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      const testSnapshotId2 = await snapshot()

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

      await revertSnapshot(testSnapshotId2)

      const tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin,
        },
        owner.address
      )
      const receipt = await tx.wait()
      const depositedEvent = receipt.events?.pop()
      const args = depositedEvent?.args ?? defaultDepositEvent

      const { amountStable, amountUniLp, amountVol } = args

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
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await weth.balanceOf(factory.address)).to.equal(0)
      expect(await weth.balanceOf(pair.address)).to.equal(0)
      expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(
        amountVol
      )
      // Uniswap LP token
      expect(
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      ).to.equal(amountUniLp)
      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(
        (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
          MINIMUM_LIQUIDITY
        )
      )
    })

    it("Should deposit twice", async function () {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await weth.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      let testSnapshotId2 = await snapshot()

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
      let wethBalanceTemp = await weth.balanceOf(owner.address)
      let excessWethLiquidityAmounts: BigNumber[] = []
      if (wethBalanceTemp.sub(wethBalanceBefore).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore),
          [weth.address, dai.address]
        )
        await uniV2Router.swapExactTokensForTokens(
          wethBalanceTemp.sub(wethBalanceBefore),
          1,
          [weth.address, dai.address],
          owner.address,
          TEN_18
        )
      }
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          weth.address,
          dai.address,
        ])
      )[1]

      await revertSnapshot(testSnapshotId2)

      let tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin,
        },
        owner.address
      )
      let receipt = await tx.wait()
      let depositedEvent = receipt.events?.pop()
      let args = depositedEvent?.args ?? defaultDepositEvent

      const { amountStable, amountUniLp, amountVol } = args

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await weth.balanceOf(owner.address))
      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      if (excessWethLiquidityAmounts.length == 0) {
        expect(amountStable.add(amountStableInit.div(2))).to.equal(
          daiBalanceBefore.sub(await dai.balanceOf(owner.address))
        )
      } else {
        const aliceDaiSpentEstimated = amountStable
          .add(amountStableInit.div(2))
          .add(excessWethLiquidityAmounts[1])
        const aliceDaiBalDiff = daiBalanceBefore.sub(
          await dai.balanceOf(owner.address)
        )
        equalTol(aliceDaiSpentEstimated, aliceDaiBalDiff)
      }
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
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
      expect(await uniLp.balanceOf(alice.address)).to.equal(0)
      expect(
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      ).to.equal(amountUniLp)
      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(
        (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
          MINIMUM_LIQUIDITY
        )
      )

      // Now to deposit again from Alice

      const wethBalanceBefore2 = await weth.balanceOf(alice.address)
      const daiBalanceBefore2 = await dai.balanceOf(alice.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      testSnapshotId2 = await snapshot()

      await dai.connect(alice).approve(uniV2Router.address, amountStableInit)
      await weth.connect(alice).approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol2 = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, weth.address]
      )
      const amountVolEstimated2 = amountsStableToVol2[1]
      await uniV2Router
        .connect(alice)
        .swapExactTokensForTokens(
          amountStableInit.sub(amountsStableToVol2[0]),
          1,
          [dai.address, weth.address],
          alice.address,
          TEN_18
        )
      const amountStableEstimated2 = amountVolEstimated2
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router
        .connect(alice)
        .addLiquidity(
          dai.address,
          weth.address,
          amountStableEstimated2,
          amountVolEstimated2,
          1,
          1,
          alice.address,
          TEN_18
        )
      wethBalanceTemp = await weth.balanceOf(alice.address)
      excessWethLiquidityAmounts = []
      if (wethBalanceTemp.sub(wethBalanceBefore2).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore2),
          [weth.address, dai.address]
        )
        await uniV2Router
          .connect(alice)
          .swapExactTokensForTokens(
            wethBalanceTemp.sub(wethBalanceBefore2),
            1,
            [weth.address, dai.address],
            alice.address,
            TEN_18
          )
      }
      const amountStableSwappedIntoEstimated2 = (
        await uniV2Router.getAmountsOut(amountVolEstimated2, [
          weth.address,
          dai.address,
        ])
      )[1]

      await revertSnapshot(testSnapshotId2)

      tx = await pair.connect(alice).deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin,
        },
        alice.address
      )
      receipt = await tx.wait()
      depositedEvent = receipt.events?.pop()
      args = depositedEvent?.args ?? defaultDepositEvent

      const {
        amountStable: amountStable2,
        amountUniLp: amountUniLp2,
        amountVol: amountVol2,
      } = args

      // factory, pair, cTokens, owner
      expect(amountVol2).to.equal(amountVolEstimated2)
      expect(amountStable2).to.equal(amountStableEstimated2)
      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      expect(await dai.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      if (excessWethLiquidityAmounts.length == 0) {
        expect(amountStable2.add(amountStableInit.div(2))).to.equal(
          daiBalanceBefore2.sub(await dai.balanceOf(alice.address))
        )
      } else {
        const aliceDaiSpentEstimated = amountStable2
          .add(amountStableInit.div(2))
          .add(excessWethLiquidityAmounts[1])
        const aliceDaiBalDiff = daiBalanceBefore2.sub(
          await dai.balanceOf(alice.address)
        )
        equalTol(aliceDaiSpentEstimated, aliceDaiBalDiff)
      }
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated2.mul(2)
      )
      // Volatile
      expect(await weth.balanceOf(factory.address)).to.equal(0)
      expect(await weth.balanceOf(pair.address)).to.equal(0)
      expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      expect(await weth.balanceOf(alice.address)).to.equal(wethBalanceBefore2)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        amountVol.add(amountVol2)
      )
      // Uniswap LP token
      expect(await uniLp.balanceOf(factory.address)).to.equal(0)
      expect(await uniLp.balanceOf(pair.address)).to.equal(0)
      expect(await uniLp.balanceOf(owner.address)).to.equal(0)
      expect(await uniLp.balanceOf(alice.address)).to.equal(0)
      expect(
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      ).to.equal(amountUniLp.add(amountUniLp2))
      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(
        (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
          MINIMUM_LIQUIDITY
        )
      )
      equalTol(
        await pair.balanceOf(alice.address),
        await pair.balanceOf(owner.address)
      )
    })
  })

  describe("withdraw()", () => {
    async function lowerWETHPrice() {
      const wethAmountBefore = await weth.balanceOf(priceCoordinator.address)

      await weth
        .connect(priceCoordinator)
        .approve(uniV2Router.address, constants.MaxUint256)

      await uniV2Router
        .connect(priceCoordinator)
        .swapExactTokensForTokens(
          wethAmountBefore.div(20),
          1,
          [weth.address, dai.address],
          priceCoordinator.address,
          TEN_18
        )
    }

    function parseUniV2BurnEvent(event: Event) {
      const abi = [
        "event Burn(address indexed sender, uint amount0, uint amount1, address indexed to)",
      ]
      const iface = new utils.Interface(abi)
      const {
        args: { sender, amount0, amount1, to },
      } = iface.parseLog(event)
      return {
        sender,
        amount0,
        amount1,
        to,
      }
    }

    async function raiseWETHPrice() {
      const daiAmountBefore = await dai.balanceOf(priceCoordinator.address)

      await dai
        .connect(priceCoordinator)
        .approve(uniV2Router.address, constants.MaxUint256)

      await uniV2Router
        .connect(priceCoordinator)
        .swapExactTokensForTokens(
          daiAmountBefore.div(10),
          1,
          [dai.address, weth.address],
          priceCoordinator.address,
          TEN_18
        )
    }

    before(async () => {
      await dai.approve(uniV2Router.address, constants.MaxUint256)
      await weth.approve(uniV2Router.address, constants.MaxUint256)
    })

    it("should work as expected when repay amount is smaller than available amount", async () => {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(`${wethPrice * 2.2}`) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 1
      const amountVolMin = 1
      const swapAmountOutMin = 1

      const wethBalanceBefore = await weth.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      let uniEstimateSnapshot = await snapshot()

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

      await revertSnapshot(uniEstimateSnapshot)

      let tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin,
        },
        owner.address
      )

      let receipt = await tx.wait()
      const depositedEvent = receipt.events?.pop()
      const args = depositedEvent?.args ?? defaultDepositEvent

      const { amountStable, amountUniLp, amountVol } = args

      const ownerLiquidityBalance = (
        await mockSqrt.sqrt(amountVol.mul(amountStable))
      ).sub(MINIMUM_LIQUIDITY)

      // Amount of volatile token to be repaid is lower than the amount to be withdrawn if we lower WETH price
      await lowerWETHPrice()

      const underlyingStableBalance =
        await cStable.callStatic.balanceOfUnderlying(pair.address)

      // Withdraw 50% of liquidity
      const liquidity = (await pair.balanceOf(owner.address)).div(2)
      const totalSupply = await pair.totalSupply()

      const amountStableFromLending = underlyingStableBalance
        .mul(liquidity)
        .div(totalSupply)

      const withdrawSwapAmountsEstimated = await uniV2Router.getAmountsOut(
        amountStableFromLending,
        [dai.address, weth.address]
      )

      const amountVolWithdrawEstimated = withdrawSwapAmountsEstimated[1]
      const amountVolToRepay = (
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
        .mul(liquidity)
        .div(totalSupply)

      // Make sure amount to repay is smaller than actual amount
      expect(amountVolToRepay).lte(amountVolWithdrawEstimated)

      const daiBalanceInUniPair = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).add(
        amountStableFromLending
      )
      const wethBalanceInUniPair = (
        await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
      ).sub(amountVolWithdrawEstimated)

      const wethInUniAfterTrade = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
      const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
        pair.address
      )
      const lpToBeRemoved = ahUniLpOwned.mul(liquidity).div(totalSupply)
      const uniLpTotalSupply = await uniLp.totalSupply()

      const { amountVolOwned, amountVolDebt, debtBps } =
        await pair.callStatic.getDebtBps()

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

      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      equalTol(
        await dai.balanceOf(owner.address),
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
        wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
      )

      // Uniswap LP token
      expect(await uniLp.balanceOf(factory.address)).to.equal(0)
      expect(await uniLp.balanceOf(pair.address)).to.equal(0)
      expect(await uniLp.balanceOf(owner.address)).to.equal(0)
      expect(
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      ).to.equal(amountUniLp)

      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(
        ownerLiquidityBalance
      )
      expect(await pair.totalSupply()).to.equal(
        BigNumber.from(MINIMUM_LIQUIDITY).add(ownerLiquidityBalance)
      )

      tx = await pair.withdraw(liquidity, {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, weth.address],
        pathVolToStable: [weth.address, dai.address],
        swapAmountOutMin,
      })

      receipt = await tx.wait()

      const uniV2BurnEventTopic = utils.id(
        "Burn(address,uint256,uint256,address)"
      )

      const burnEvents = receipt.events?.filter(({ topics }) =>
        topics.includes(uniV2BurnEventTopic)
      )

      // Check if it runs `IF` case
      expect(burnEvents?.length).to.equal(1)

      const burnEventArgs = parseUniV2BurnEvent(burnEvents![0])

      expect(burnEventArgs.sender).to.equal(uniV2Router.address)
      equalTol(
        burnEventArgs.amount0,
        lpToBeRemoved.mul(daiBalanceInUniPair).div(uniLpTotalSupply)
      )
      equalTol(
        burnEventArgs.amount1,
        lpToBeRemoved.mul(wethBalanceInUniPair).div(uniLpTotalSupply)
      )
      expect(burnEventArgs.to).to.equal(pair.address)
    })

    it("should work as expected when repay amount is more than available amount", async () => {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(`${wethPrice * 2.2}`) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 1
      const amountVolMin = 1
      const swapAmountOutMin = 1

      const wethBalanceBefore = await weth.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      let uniEstimateSnapshot = await snapshot()

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

      await revertSnapshot(uniEstimateSnapshot)

      let tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin,
        },
        owner.address
      )

      let receipt = await tx.wait()
      const depositedEvent = receipt.events?.pop()
      const args = depositedEvent?.args ?? defaultDepositEvent

      const { amountStable, amountUniLp, amountVol } = args

      const ownerLiquidityBalance = (
        await mockSqrt.sqrt(amountVol.mul(amountStable))
      ).sub(MINIMUM_LIQUIDITY)

      // Amount of volatile token to be repaid is lower than the amount to be withdrawn if we lower WETH price
      await raiseWETHPrice()

      // Withdraw 50% of liquidity
      const liquidity = (await pair.balanceOf(owner.address)).div(2)
      const totalSupply = await pair.totalSupply()

      const wethInUniAfterTrade = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
      const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
        pair.address
      )
      const lpToBeRemoved = ahUniLpOwned.mul(liquidity).div(totalSupply)
      const uniLpTotalSupply = await uniLp.totalSupply()

      const { amountVolOwned, amountVolDebt, debtBps } =
        await pair.callStatic.getDebtBps()

      expect(amountVolOwned).equal(
        wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
      )
      expect(amountVolDebt).equal(
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
      expect(debtBps).equal(amountVolDebt.mul(TEN_18).div(amountVolOwned))

      const estStableToRedeem = (
        await uniV2Router.getAmountsIn(amountVolDebt.sub(amountVolOwned), [
          dai.address,
          weth.address,
        ])
      )[0]

      await pair.rebalance()

      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      equalTol(
        await dai.balanceOf(owner.address),
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated.sub(estStableToRedeem)
      )

      // Volatile
      expect(await weth.balanceOf(factory.address)).to.equal(0)
      expect(await weth.balanceOf(pair.address)).to.equal(0)
      expect(await weth.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
      )

      // Uniswap LP token
      expect(await uniLp.balanceOf(factory.address)).to.equal(0)
      expect(await uniLp.balanceOf(pair.address)).to.equal(0)
      expect(await uniLp.balanceOf(owner.address)).to.equal(0)
      expect(
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      ).to.equal(amountUniLp)

      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(
        ownerLiquidityBalance
      )
      expect(await pair.totalSupply()).to.equal(
        BigNumber.from(MINIMUM_LIQUIDITY).add(ownerLiquidityBalance)
      )

      const underlyingStableBalance =
        await cStable.callStatic.balanceOfUnderlying(pair.address)

      const amountStableFromLending = underlyingStableBalance
        .mul(liquidity)
        .div(totalSupply)

      const withdrawSwapAmountsEstimated = await uniV2Router.getAmountsOut(
        amountStableFromLending,
        [dai.address, weth.address]
      )

      const amountVolWithdrawEstimated = withdrawSwapAmountsEstimated[1]
      const amountVolToRepay = (
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
        .mul(liquidity)
        .div(totalSupply)

      // Make sure amount to repay is smaller than actual amount
      expect(amountVolToRepay).gt(amountVolWithdrawEstimated)

      const daiBalanceInUniPair = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR)).add(
        amountStableFromLending
      )
      const wethBalanceInUniPair = (
        await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
      ).sub(amountVolWithdrawEstimated)

      tx = await pair.withdraw(liquidity, {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, weth.address],
        pathVolToStable: [weth.address, dai.address],
        swapAmountOutMin,
      })

      receipt = await tx.wait()

      const uniV2BurnEventTopic = utils.id(
        "Burn(address,uint256,uint256,address)"
      )

      const burnEvents = receipt.events?.filter(({ topics }) =>
        topics.includes(uniV2BurnEventTopic)
      )

      // Check if it runs `else` case. Should have 2 liquidity removals
      expect(burnEvents?.length).to.equal(2)

      const paidLpBurnEventArgs = parseUniV2BurnEvent(burnEvents![0])

      const remainingLpBurnEventArgs = parseUniV2BurnEvent(burnEvents![1])

      const amountUniLpPaidFirst = lpToBeRemoved
        .mul(amountVolWithdrawEstimated)
        .div(amountVolToRepay)

      // Check first LP removal for repaying remaining volatile token amount
      expect(paidLpBurnEventArgs.sender).to.equal(uniV2Router.address)
      equalTol(
        paidLpBurnEventArgs.amount0,
        amountUniLpPaidFirst.mul(daiBalanceInUniPair).div(uniLpTotalSupply)
      )
      equalTol(
        paidLpBurnEventArgs.amount1,
        amountUniLpPaidFirst.mul(wethBalanceInUniPair).div(uniLpTotalSupply)
      )
      expect(paidLpBurnEventArgs.to).to.equal(pair.address)

      const daiBalanceInUniPairAfterRepay = daiBalanceInUniPair.sub(
        paidLpBurnEventArgs.amount0
      )
      const wethBalanceInUniPairAfterRepay = wethBalanceInUniPair.sub(
        paidLpBurnEventArgs.amount1
      )
      const amountUniLpAfterRepay = lpToBeRemoved.sub(amountUniLpPaidFirst)
      const lpTotalSupplyAfterRepay = uniLpTotalSupply.sub(amountUniLpPaidFirst)

      // Check the second LP removal
      expect(remainingLpBurnEventArgs.sender).to.equal(uniV2Router.address)
      equalTol(
        remainingLpBurnEventArgs.amount0,
        amountUniLpAfterRepay
          .mul(daiBalanceInUniPairAfterRepay)
          .div(lpTotalSupplyAfterRepay)
      )
      equalTol(
        remainingLpBurnEventArgs.amount1,
        amountUniLpAfterRepay
          .mul(wethBalanceInUniPairAfterRepay)
          .div(lpTotalSupplyAfterRepay)
      )
      expect(remainingLpBurnEventArgs.to).to.equal(pair.address)
    })
  })

  it("Should rebalance, borrow more ETH, no fee", async function () {
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
    const testSnapshotId2 = await snapshot()

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

    await revertSnapshot(testSnapshotId2)

    const tx = await pair.deposit(
      amountStableInit,
      amountVolZapMin,
      {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, weth.address],
        pathVolToStable: [weth.address, dai.address],
        swapAmountOutMin,
      },
      owner.address
    )
    const receipt = await tx.wait()
    const depositedEvent = receipt.events?.pop()
    const args = depositedEvent?.args ?? defaultDepositEvent

    const { amountStable, amountUniLp, amountVol } = args

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
    equalTol(
      await cStable.callStatic.balanceOfUnderlying(pair.address),
      amountStableSwappedIntoEstimated
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
    const wethInUniBeforeTrade = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
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

    const wethInUniAfterTrade = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
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
      wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
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
