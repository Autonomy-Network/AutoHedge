import { ethers } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { UniswapV2Router02, WETH } from "typechain/thirdparty"
import {
  DeltaNeutralStableVolatileFactoryUpgradeable,
  DeltaNeutralStableVolatilePairUpgradeable,
  ICErc20,
  IERC20,
  MockSqrt,
  UBeacon,
  Registry,
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

import UNI from "../thirdparty/UNI.json"
import USDC from "../thirdparty/USDC.json"
import UniswapV2Router02Abi from "../thirdparty/UniswapV2Router02.json"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, constants, ContractReceipt, Event, utils } from "ethers"

const abi = new ethers.utils.AbiCoder()

const { parseEther, formatEther, formatUnits, parseUnits } = ethers.utils

const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"

const MINIMUM_LIQUIDITY = 1000

const RES_TOL_LOWER = 999990
const RES_TOL_UPPER = 1000010
const RES_TOL_TOTAL = 1000000
const TEN_18 = 10 ** 18
const AUTO_ID = 0
const MIN_GAS = 21000

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
  let feeReceiver: SignerWithAddress
  let referrer: SignerWithAddress

  let uni: IERC20
  let usdc: IERC20
  let uniV2Router: UniswapV2Router02

  let factory: DeltaNeutralStableVolatileFactoryUpgradeable
  let pair: DeltaNeutralStableVolatilePairUpgradeable

  const UNIV2_USDC_UNI_ADDR = "0xEBFb684dD2b01E698ca6c14F10e4f289934a54D6"
  let uniLp: IERC20
  let cVol: ICErc20
  let cStable: ICErc20
  let cUniLp: ICErc20

  const c = (artifact: ArtifactType) =>
    new ethers.Contract(artifact.address, artifact.abi, owner)

  let deploySnapshotId: string
  let testSnapshotId: string

  let beacon: UBeacon
  let pairImpl: DeltaNeutralStableVolatilePairUpgradeable

  let registry: Registry

  const TEN_18 = parseUSDC("1")

  async function getUNIPrice() {
    return +formatUnits(
      (
        await uniV2Router.getAmountsOut(parseEther("1"), [
          uni.address,
          usdc.address,
        ])
      )[1],
      "mwei"
    )
  }

  function getDepositEvent(receipt: ContractReceipt) {
    const depositedEvent = receipt.events?.find(
      ({ event }) => event === "Deposited"
    )
    return depositedEvent?.args ?? defaultDepositEvent
  }

  async function estimateDeposit(amountStableInit: BigNumber) {
    const testSnapshotId2 = await snapshot()

    await usdc.approve(uniV2Router.address, constants.MaxUint256)
    await uni.approve(uniV2Router.address, constants.MaxUint256)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [usdc.address, uni.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [usdc.address, uni.address],
      owner.address,
      constants.MaxUint256
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await usdc.balanceOf(UNIV2_USDC_UNI_ADDR))
      .div(await uni.balanceOf(UNIV2_USDC_UNI_ADDR))
    const { liquidity } = await uniV2Router.callStatic.addLiquidity(
      usdc.address,
      uni.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      constants.MaxUint256
    )
    console.log(liquidity)
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        uni.address,
        usdc.address,
      ])
    )[1]

    await revertSnapshot(testSnapshotId2)

    return {
      amountsStableToVol,
      amountVolEstimated,
      amountStableEstimated,
      amountStableSwappedIntoEstimated,
    }
  }

  before(async () => {
    ;[owner, bob, alice, priceCoordinator, feeReceiver, referrer] =
      await ethers.getSigners()

    addresses = getAddresses()

    uni = <WETH>c(UNI)
    usdc = <IERC20>c(USDC)
    uniV2Router = <UniswapV2Router02>c(UniswapV2Router02Abi)

    // ethPrice = parseInt((await uniV2Router.getAmountsOut(parseUSDC('1'), [uni.address, usdc.address]))[1].div(parseUSDC('1')))
    ethPrice = await getEthPrice()
    expect(ethPrice).to.be.greaterThan(0)

    // It's fucking dumb that BigNumber doesn't support sqrt operations -.- need to mock using the sqrt used in Solidity
    const MockSqrtFactory = await ethers.getContractFactory("MockSqrt")
    const UBeaconFactory = await ethers.getContractFactory("UBeacon")
    const DeltaNeutralStableVolatileFactoryUpgradeable =
      await ethers.getContractFactory(
        "DeltaNeutralStableVolatileFactoryUpgradeable"
      )
    const DeltaNeutralStableVolatilePairUpgradeableFactory =
      await ethers.getContractFactory(
        "DeltaNeutralStableVolatilePairUpgradeable"
      )
    const RegistryFactory = await ethers.getContractFactory("Registry")

    mockSqrt = <MockSqrt>await MockSqrtFactory.deploy()
    pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
    )
    beacon = <UBeacon>await UBeaconFactory.deploy(pairImpl.address)
    console.log("UpgradeableBeacon: ", beacon.address)
    factory = <DeltaNeutralStableVolatileFactoryUpgradeable>(
      await DeltaNeutralStableVolatileFactoryUpgradeable.deploy()
    )

    await factory.initialize(
      beacon.address,
      uni.address,
      UNIV2_FACTORY_ADDR,
      UniswapV2Router02Abi.address,
      addresses.unitroller,
      addresses.reg,
      addresses.uff,
      {
        min: parseUSDC("0.99"),
        max: parseUSDC("1.01"),
      },
      feeReceiver.address
    )

    const tx = await factory.createPair(usdc.address, uni.address)
    const receipt = await tx.wait()
    const lastEvent = receipt.events?.pop()
    const pairAddress = lastEvent ? lastEvent.args?.pair : ""

    pair = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.attach(pairAddress)
    )

    registry = <Registry>await RegistryFactory.attach(addresses.reg)

    expect(await pair.autoId()).equal(AUTO_ID)

    const tokens = await pair.tokens()
    uniLp = <IERC20>new ethers.Contract(tokens.uniLp, UNI.abi, owner)
    cVol = <ICErc20>new ethers.Contract(tokens.cVol, ICErc20Abi.abi, owner)
    cStable = <ICErc20>(
      new ethers.Contract(tokens.cStable, ICErc20Abi.abi, owner)
    )
    cUniLp = <ICErc20>new ethers.Contract(tokens.cUniLp, ICErc20Abi.abi, owner)

    await uni.approve(pair.address, constants.MaxUint256)
    await uni.connect(bob).approve(pair.address, constants.MaxUint256)
    await uni.connect(alice).approve(pair.address, constants.MaxUint256)
    await usdc.approve(pair.address, constants.MaxUint256)
    await usdc.connect(bob).approve(pair.address, constants.MaxUint256)
    await usdc.connect(alice).approve(pair.address, constants.MaxUint256)
  })

  // Want to reset to the state just after fuseDeploy
  after(async () => {
    await revertSnapshot(addresses.snapshotId)
    addresses.snapshotId = await snapshot()
    fs.writeFileSync("addresses.json", JSON.stringify(addresses))
  })

  beforeEach(async () => {
    testSnapshotId = await snapshot()
  })

  afterEach(async () => {
    await revertSnapshot(testSnapshotId)
  })

  function parseUSDC(amount: string) {
    return parseUnits(amount, "mwei")
  }

  describe("deposit()", () => {
    it.only("Should deposit", async () => {
      const uniPrice = await getUNIPrice()

      const amountStableInit = parseUSDC((1.1 * uniPrice * 2).toFixed(6)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = 0
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await uni.balanceOf(owner.address)
      const daiBalanceBefore = await usdc.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after

      const {
        amountsStableToVol,
        amountVolEstimated,
        amountStableEstimated,
        amountStableSwappedIntoEstimated,
      } = await estimateDeposit(amountStableInit)

      const tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        owner.address,
        constants.AddressZero
      )
      const receipt = await tx.wait()

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await uni.balanceOf(owner.address))
      expect(amountStable.add(amountStableInit.div(2))).to.equal(
        daiBalanceBefore.sub(await usdc.balanceOf(owner.address))
      )
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const liqudityFee = liquidity.mul(await factory.depositFee()).div(TEN_18) // 0.3% fee
      expect(await pair.balanceOf(owner.address)).to.equal(
        liquidity.sub(liqudityFee)
      )
      expect(await pair.balanceOf(feeReceiver.address)).to.equal(liqudityFee)
    })

    it("Should deposit twice", async () => {
      const wethPrice = await getUNIPrice()

      const amountStableInit = parseUSDC(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseUSDC("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await uni.balanceOf(owner.address)
      const daiBalanceBefore = await usdc.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      let testSnapshotId2 = await snapshot()

      await usdc.approve(uniV2Router.address, amountStableInit)
      await uni.approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [usdc.address, uni.address]
      )
      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [usdc.address, uni.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await usdc.balanceOf(UNIV2_USDC_UNI_ADDR))
        .div(await uni.balanceOf(UNIV2_USDC_UNI_ADDR))
      await uniV2Router.addLiquidity(
        usdc.address,
        uni.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      let wethBalanceTemp = await uni.balanceOf(owner.address)
      let excessWethLiquidityAmounts: BigNumber[] = []
      if (wethBalanceTemp.sub(wethBalanceBefore).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore),
          [uni.address, usdc.address]
        )
        await uniV2Router.swapExactTokensForTokens(
          wethBalanceTemp.sub(wethBalanceBefore),
          1,
          [uni.address, usdc.address],
          owner.address,
          TEN_18
        )
      }
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          uni.address,
          usdc.address,
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
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        owner.address,
        constants.AddressZero
      )
      let receipt = await tx.wait()

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await uni.balanceOf(owner.address))
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      if (excessWethLiquidityAmounts.length == 0) {
        expect(amountStable.add(amountStableInit.div(2))).to.equal(
          daiBalanceBefore.sub(await usdc.balanceOf(owner.address))
        )
      } else {
        const aliceDaiSpentEstimated = amountStable
          .add(amountStableInit.div(2))
          .add(excessWethLiquidityAmounts[1])
        const aliceDaiBalDiff = daiBalanceBefore.sub(
          await usdc.balanceOf(owner.address)
        )
        equalTol(aliceDaiSpentEstimated, aliceDaiBalDiff)
      }
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const depositFee = await factory.depositFee()
      const liquidityFee = liquidity.mul(depositFee).div(TEN_18)
      expect(await pair.balanceOf(owner.address)).to.equal(
        liquidity.sub(liquidityFee)
      )
      expect(await pair.balanceOf(feeReceiver.address)).to.equal(liquidityFee)

      // Now to deposit again from Alice

      const wethBalanceBefore2 = await uni.balanceOf(alice.address)
      const daiBalanceBefore2 = await usdc.balanceOf(alice.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      testSnapshotId2 = await snapshot()

      await usdc.connect(alice).approve(uniV2Router.address, amountStableInit)
      await uni.connect(alice).approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol2 = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [usdc.address, uni.address]
      )
      const amountVolEstimated2 = amountsStableToVol2[1]
      await uniV2Router
        .connect(alice)
        .swapExactTokensForTokens(
          amountStableInit.sub(amountsStableToVol2[0]),
          1,
          [usdc.address, uni.address],
          alice.address,
          TEN_18
        )
      const amountStableEstimated2 = amountVolEstimated2
        .mul(await usdc.balanceOf(UNIV2_USDC_UNI_ADDR))
        .div(await uni.balanceOf(UNIV2_USDC_UNI_ADDR))
      await uniV2Router
        .connect(alice)
        .addLiquidity(
          usdc.address,
          uni.address,
          amountStableEstimated2,
          amountVolEstimated2,
          1,
          1,
          alice.address,
          TEN_18
        )
      wethBalanceTemp = await uni.balanceOf(alice.address)
      excessWethLiquidityAmounts = []
      if (wethBalanceTemp.sub(wethBalanceBefore2).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore2),
          [uni.address, usdc.address]
        )
        await uniV2Router
          .connect(alice)
          .swapExactTokensForTokens(
            wethBalanceTemp.sub(wethBalanceBefore2),
            1,
            [uni.address, usdc.address],
            alice.address,
            TEN_18
          )
      }
      const amountStableSwappedIntoEstimated2 = (
        await uniV2Router.getAmountsOut(amountVolEstimated2, [
          uni.address,
          usdc.address,
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
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        alice.address,
        constants.AddressZero
      )
      receipt = await tx.wait()

      const {
        amountStable: amountStable2,
        amountUniLp: amountUniLp2,
        amountVol: amountVol2,
      } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol2).to.equal(amountVolEstimated2)
      expect(amountStable2).to.equal(amountStableEstimated2)
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      if (excessWethLiquidityAmounts.length == 0) {
        expect(amountStable2.add(amountStableInit.div(2))).to.equal(
          daiBalanceBefore2.sub(await usdc.balanceOf(alice.address))
        )
      } else {
        const aliceDaiSpentEstimated = amountStable2
          .add(amountStableInit.div(2))
          .add(excessWethLiquidityAmounts[1])
        const aliceDaiBalDiff = daiBalanceBefore2.sub(
          await usdc.balanceOf(alice.address)
        )
        equalTol(aliceDaiSpentEstimated, aliceDaiBalDiff)
      }
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated2.mul(2)
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      expect(await uni.balanceOf(alice.address)).to.equal(wethBalanceBefore2)
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
      const liquidity2 = (await pair.totalSupply())
        .mul(amountUniLp2)
        .div(amountUniLp.add(amountUniLp2))
      expect(await pair.balanceOf(feeReceiver.address)).to.equal(
        liquidityFee.add(liquidity2.mul(depositFee).div(TEN_18))
      )
      equalTol(
        await pair.balanceOf(alice.address),
        await pair.balanceOf(owner.address)
      )
    })

    it("Should deposit to referrer", async () => {
      const wethPrice = await getUNIPrice()

      const amountStableInit = parseUSDC(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseUSDC("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await uni.balanceOf(owner.address)
      const daiBalanceBefore = await usdc.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after

      const {
        amountsStableToVol,
        amountVolEstimated,
        amountStableEstimated,
        amountStableSwappedIntoEstimated,
      } = await estimateDeposit(amountStableInit)

      const tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        owner.address,
        referrer.address
      )
      const receipt = await tx.wait()

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await uni.balanceOf(owner.address))
      expect(amountStable.add(amountStableInit.div(2))).to.equal(
        daiBalanceBefore.sub(await usdc.balanceOf(owner.address))
      )
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const liqudityFee = liquidity.mul(await factory.depositFee()).div(TEN_18) // 0.3% fee
      expect(await pair.balanceOf(owner.address)).to.equal(
        liquidity.sub(liqudityFee)
      )
      expect(await pair.balanceOf(referrer.address)).to.equal(liqudityFee)
    })

    it("Should deposit correctly after `depositFee` and `feeReceiver` values are updated", async () => {
      const wethPrice = await getUNIPrice()

      const amountStableInit = parseUSDC(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseUSDC("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await uni.balanceOf(owner.address)
      const daiBalanceBefore = await usdc.balanceOf(owner.address)

      // Update deposit fee and fee receiver

      // Set deposit fee as 1%
      const newDepositFee = BigNumber.from(TEN_18).div(100)
      await expect(factory.setDepositFee(newDepositFee))
        .to.emit(factory, "DepositFeeSet")
        .withArgs(newDepositFee)

      expect(await factory.depositFee()).to.equal(newDepositFee)

      // Set referrer as new fee receiver
      await expect(factory.setFeeReceiver(referrer.address))
        .to.emit(factory, "FeeReceiverSet")
        .withArgs(referrer.address)

      expect(await factory.feeReceiver()).to.equal(referrer.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after

      const {
        amountsStableToVol,
        amountVolEstimated,
        amountStableEstimated,
        amountStableSwappedIntoEstimated,
      } = await estimateDeposit(amountStableInit)

      const tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        owner.address,
        constants.AddressZero
      )
      const receipt = await tx.wait()

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await uni.balanceOf(owner.address))
      expect(amountStable.add(amountStableInit.div(2))).to.equal(
        daiBalanceBefore.sub(await usdc.balanceOf(owner.address))
      )
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const liqudityFee = liquidity.mul(newDepositFee).div(TEN_18)
      expect(await pair.balanceOf(owner.address)).to.equal(
        liquidity.sub(liqudityFee)
      )
      expect(await pair.balanceOf(referrer.address)).to.equal(liqudityFee)
    })
  })

  describe("rebalance()", () => {
    it("Should rebalance, borrow more ETH, no fee", async () => {
      const amountStableInit = parseUSDC(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseUSDC("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await uni.balanceOf(owner.address)
      const daiBalanceBefore = await usdc.balanceOf(owner.address)

      const {
        amountsStableToVol,
        amountVolEstimated,
        amountStableEstimated,
        amountStableSwappedIntoEstimated,
      } = await estimateDeposit(amountStableInit)

      const tx = await pair.deposit(
        amountStableInit,
        amountVolZapMin,
        {
          amountStableMin,
          amountVolMin,
          deadline: noDeadline,
          pathStableToVol: [usdc.address, uni.address],
          pathVolToStable: [uni.address, usdc.address],
          swapAmountOutMin,
        },
        owner.address,
        constants.AddressZero
      )
      const receipt = await tx.wait()

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await uni.balanceOf(owner.address))
      expect(amountStable.add(amountStableInit.div(2))).to.equal(
        daiBalanceBefore.sub(await usdc.balanceOf(owner.address))
      )
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(
        amountVol
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
      const liquidityTotal = (
        await mockSqrt.sqrt(amountVol.mul(amountStable))
      ).sub(MINIMUM_LIQUIDITY)
      const liqudityFee = liquidityTotal
        .mul(await factory.depositFee())
        .div(TEN_18)
      const ownerLiquidityBalance = liquidityTotal.sub(liqudityFee)
      expect(await pair.balanceOf(owner.address)).to.equal(
        ownerLiquidityBalance
      )

      // Should revert when trying to rebalance when it's not needed
      await expect(pair.rebalance(false)).to.be.revertedWith(
        REV_MSG_WITHIN_RANGE
      )

      // Increase the amount of ETH held in the DEX
      const wethInUniBeforeTrade = await uni.balanceOf(UNIV2_USDC_UNI_ADDR)
      const amountWethSell = parseUSDC("1000")
      await uni.connect(bob).approve(uniV2Router.address, amountWethSell)
      await uniV2Router
        .connect(bob)
        .swapExactTokensForTokens(
          amountWethSell,
          1,
          [uni.address, usdc.address],
          bob.address,
          TEN_18
        )

      const wethInUniAfterTrade = await uni.balanceOf(UNIV2_USDC_UNI_ADDR)
      const {
        owned: amountVolOwned,
        debt: amountVolDebt,
        bps: debtBps,
      } = await pair.callStatic.getDebtBps()

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
          uni.address,
          usdc.address,
        ])
      )[1]

      await pair.rebalance(false)

      // factory, pair, cTokens, owner
      // Stable
      expect(await usdc.balanceOf(factory.address)).to.equal(0)
      expect(await usdc.balanceOf(pair.address)).to.equal(0)
      expect(await usdc.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated.add(estStableFromVol)
      )

      // Volatile
      expect(await uni.balanceOf(factory.address)).to.equal(0)
      expect(await uni.balanceOf(pair.address)).to.equal(0)
      expect(await uni.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
        ethers.BigNumber.from(MINIMUM_LIQUIDITY).add(liquidityTotal)
      )
    })
  })

  // TODO: test rebalance with a fee
  // TODO: test big rebalance value such that it's out of balance after rebalancing
  // TODO: test deposit with large enough deposit for the debt to be out of sync at the end
  // TODO: test withdraw with large enough withdraw for the debt to be out of sync at the end
  // TODO: test that the rebalance condition isn't triggered by people adding liquidity
  // TODO: test rebalance with non-ETH asset
})
