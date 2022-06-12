import { ethers, network } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { UniswapV2Router02 } from "typechain/thirdparty"
import {
  DeltaNeutralStableVolatileFactory,
  DeltaNeutralStableVolatilePairUpgradeable,
  ICErc20,
  IERC20,
  MockSqrt,
  TProxyAdmin,
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

import UNIAbi from "../thirdparty/UNI.json"
import DAI from "../thirdparty/DAI.json"
import UniswapV2Router02Abi from "../thirdparty/UniswapV2Router02.json"
import FuseFeeDistributorAbi from "../thirdparty/FuseFeeDistributor.json"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, constants, Event, utils } from "ethers"

const abi = new ethers.utils.AbiCoder()

const { parseEther, formatEther } = ethers.utils

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

  let vol: IERC20
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

  let deploySnapshotId: string
  let testSnapshotId: string

  let admin: TProxyAdmin
  let pairImpl: DeltaNeutralStableVolatilePairUpgradeable

  let registry: Registry

  const TEN_18 = parseEther("1")

  async function getWETHPrice() {
    return +formatEther(
      (
        await uniV2Router.getAmountsOut(parseEther("1"), [
          vol.address,
          dai.address,
        ])
      )[1]
    )
  }

  before(async () => {
    ;[owner, bob, alice, priceCoordinator] = await ethers.getSigners()

    addresses = getAddresses()

    vol = <IERC20>c(UNIAbi)
    dai = <IERC20>c(DAI)
    uniV2Router = <UniswapV2Router02>c(UniswapV2Router02Abi)

    // ethPrice = parseInt((await uniV2Router.getAmountsOut(parseEther('1'), [vol.address, dai.address]))[1].div(parseEther('1')))
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
    const RegistryFactory = await ethers.getContractFactory("Registry")

    mockSqrt = <MockSqrt>await MockSqrtFactory.deploy()
    admin = <TProxyAdmin>await TProxyAdminFactory.deploy()
    pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
    )
    factory = <DeltaNeutralStableVolatileFactory>(
      await DeltaNeutralStableVolatileFactory.deploy(
        pairImpl.address,
        admin.address,
        vol.address,
        UNIV2_FACTORY_ADDR,
        UniswapV2Router02Abi.address,
        addresses.unitroller,
        addresses.reg,
        addresses.uff,
        {
          min: parseEther("0.99"),
          max: parseEther("1.01"),
        }
      )
    )

    const tx = await factory.createPair(dai.address, vol.address)
    const receipt = await tx.wait()
    const lastEvent = receipt.events?.pop()
    const pairAddress = lastEvent ? lastEvent.args?.pair : ""

    pair = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.attach(pairAddress)
    )

    registry = <Registry>(await RegistryFactory.attach(addresses.reg))

    expect(await pair.autoId()).equal(AUTO_ID)

    const tokens = await pair.tokens()
    uniLp = <IERC20>new ethers.Contract(tokens.uniLp, UNIAbi.abi, owner)
    cVol = <ICErc20>new ethers.Contract(tokens.cVol, ICErc20Abi.abi, owner)
    cStable = <ICErc20>(
      new ethers.Contract(tokens.cStable, ICErc20Abi.abi, owner)
    )
    cUniLp = <ICErc20>new ethers.Contract(tokens.cUniLp, ICErc20Abi.abi, owner)

    await vol.approve(pair.address, constants.MaxUint256)
    await vol.connect(bob).approve(pair.address, constants.MaxUint256)
    await vol.connect(alice).approve(pair.address, constants.MaxUint256)
    await dai.approve(pair.address, constants.MaxUint256)
    await dai.connect(bob).approve(pair.address, constants.MaxUint256)
    await dai.connect(alice).approve(pair.address, constants.MaxUint256)
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

  describe("deposit()", () => {
    it("Should deposit", async function () {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(String(1.1 * wethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 0
      const amountVolMin = 0
      const swapAmountOutMin = 0

      const wethBalanceBefore = await vol.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      const testSnapshotId2 = await snapshot()

      await dai.approve(uniV2Router.address, amountStableInit)
      await vol.approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )
      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [dai.address, vol.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router.addLiquidity(
        dai.address,
        vol.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
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
      expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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

      const wethBalanceBefore = await vol.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      let testSnapshotId2 = await snapshot()

      await dai.approve(uniV2Router.address, amountStableInit)
      await vol.approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )
      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [dai.address, vol.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router.addLiquidity(
        dai.address,
        vol.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      let wethBalanceTemp = await vol.balanceOf(owner.address)
      let excessWethLiquidityAmounts: BigNumber[] = []
      if (wethBalanceTemp.sub(wethBalanceBefore).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore),
          [vol.address, dai.address]
        )
        await uniV2Router.swapExactTokensForTokens(
          wethBalanceTemp.sub(wethBalanceBefore),
          1,
          [vol.address, dai.address],
          owner.address,
          TEN_18
        )
      }
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
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
      expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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

      const wethBalanceBefore2 = await vol.balanceOf(alice.address)
      const daiBalanceBefore2 = await dai.balanceOf(alice.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      testSnapshotId2 = await snapshot()

      await dai.connect(alice).approve(uniV2Router.address, amountStableInit)
      await vol.connect(alice).approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol2 = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )
      const amountVolEstimated2 = amountsStableToVol2[1]
      await uniV2Router
        .connect(alice)
        .swapExactTokensForTokens(
          amountStableInit.sub(amountsStableToVol2[0]),
          1,
          [dai.address, vol.address],
          alice.address,
          TEN_18
        )
      const amountStableEstimated2 = amountVolEstimated2
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router
        .connect(alice)
        .addLiquidity(
          dai.address,
          vol.address,
          amountStableEstimated2,
          amountVolEstimated2,
          1,
          1,
          alice.address,
          TEN_18
        )
      wethBalanceTemp = await vol.balanceOf(alice.address)
      excessWethLiquidityAmounts = []
      if (wethBalanceTemp.sub(wethBalanceBefore2).gt(0)) {
        excessWethLiquidityAmounts = await uniV2Router.getAmountsOut(
          wethBalanceTemp.sub(wethBalanceBefore2),
          [vol.address, dai.address]
        )
        await uniV2Router
          .connect(alice)
          .swapExactTokensForTokens(
            wethBalanceTemp.sub(wethBalanceBefore2),
            1,
            [vol.address, dai.address],
            alice.address,
            TEN_18
          )
      }
      const amountStableSwappedIntoEstimated2 = (
        await uniV2Router.getAmountsOut(amountVolEstimated2, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
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
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      expect(await vol.balanceOf(alice.address)).to.equal(wethBalanceBefore2)
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
      const wethAmountBefore = await vol.balanceOf(priceCoordinator.address)

      await vol
        .connect(priceCoordinator)
        .approve(uniV2Router.address, constants.MaxUint256)

      await uniV2Router
        .connect(priceCoordinator)
        .swapExactTokensForTokens(
          wethAmountBefore.div(20),
          1,
          [vol.address, dai.address],
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
          [dai.address, vol.address],
          priceCoordinator.address,
          TEN_18
        )
    }

    before(async () => {
      await dai.approve(uniV2Router.address, constants.MaxUint256)
      await vol.approve(uniV2Router.address, constants.MaxUint256)
    })

    it("should work as expected when repay amount is smaller than available amount", async () => {
      const wethPrice = await getWETHPrice()

      const amountStableInit = parseEther(`${wethPrice * 2.2}`) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 1
      const amountVolMin = 1
      const swapAmountOutMin = 1

      const wethBalanceBefore = await vol.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      let uniEstimateSnapshot = await snapshot()

      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )

      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [dai.address, vol.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router.addLiquidity(
        dai.address,
        vol.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
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
        [dai.address, vol.address]
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
        await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      ).sub(amountVolWithdrawEstimated)

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
        pair.address
      )
      const lpToBeRemoved = ahUniLpOwned.mul(liquidity).div(totalSupply)
      const uniLpTotalSupply = await uniLp.totalSupply()

      const { owned, debt, bps } =
        await pair.callStatic.getDebtBps()

      expect(owned).equal(
        wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
      )
      expect(debt).equal(
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
      expect(bps).equal(debt.mul(TEN_18).div(owned))

      const estStableFromVol = (
        await uniV2Router.getAmountsOut(owned.sub(debt), [
          vol.address,
          dai.address,
        ])
      )[1]

      await pair.rebalance(false)

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
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        owned
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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

      const wethBalanceBefore = await vol.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      let uniEstimateSnapshot = await snapshot()

      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )

      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [dai.address, vol.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router.addLiquidity(
        dai.address,
        vol.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
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

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
        pair.address
      )
      const lpToBeRemoved = ahUniLpOwned.mul(liquidity).div(totalSupply)
      const uniLpTotalSupply = await uniLp.totalSupply()

      const { owned, debt, bps } =
        await pair.callStatic.getDebtBps()

      expect(owned).equal(
        wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
      )
      expect(debt).equal(
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
      expect(bps).equal(debt.mul(TEN_18).div(owned))

      const estStableToRedeem = (
        await uniV2Router.getAmountsIn(debt.sub(owned), [
          dai.address,
          vol.address,
        ])
      )[0]

      await pair.rebalance(false)

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
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        owned
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
        [dai.address, vol.address]
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
        await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      ).sub(amountVolWithdrawEstimated)

      tx = await pair.withdraw(liquidity, {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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

    it("should work as expected", async () => {
      const wethPrice = await getWETHPrice()

      // deposit to withdraw
      const amountStableInit = parseEther(`${wethPrice * 2.2}`) // fuse min borrow amount is 1 ETH, and half is kept as DAI
      const amountVolZapMin = parseEther("1")
      const amountStableMin = 1
      const amountVolMin = 1
      const swapAmountOutMin = 1

      const wethBalanceBefore = await vol.balanceOf(owner.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
      // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
      // 1st to measure the reserves after
      const testSnapshotId2 = await snapshot()

      await dai.approve(uniV2Router.address, amountStableInit)
      await vol.approve(uniV2Router.address, amountStableInit)
      const amountsStableToVol = await uniV2Router.getAmountsOut(
        amountStableInit.div(2),
        [dai.address, vol.address]
      )

      const amountVolEstimated = amountsStableToVol[1]
      await uniV2Router.swapExactTokensForTokens(
        amountStableInit.sub(amountsStableToVol[0]),
        1,
        [dai.address, vol.address],
        owner.address,
        TEN_18
      )
      const amountStableEstimated = amountVolEstimated
        .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
        .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
      await uniV2Router.addLiquidity(
        dai.address,
        vol.address,
        amountStableEstimated,
        amountVolEstimated,
        1,
        1,
        owner.address,
        TEN_18
      )
      const amountStableSwappedIntoEstimated = (
        await uniV2Router.getAmountsOut(amountVolEstimated, [
          vol.address,
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
          pathStableToVol: [dai.address, vol.address],
          pathVolToStable: [vol.address, dai.address],
          swapAmountOutMin,
        },
        owner.address
      )
      let receipt = await tx.wait()
      const depositedEvent = receipt.events?.pop()
      const args = depositedEvent?.args ?? defaultDepositEvent

      const { amountStable, amountUniLp, amountVol } = args

      // factory, pair, cTokens, owner
      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)
      expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
      equalTol(
        amountStable.add(amountStableInit.div(2)),
        daiBalanceBefore.sub(await dai.balanceOf(owner.address))
      )

      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      equalTol(
        await dai.balanceOf(owner.address),
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      // It's off by 1 wei, not sure why, very likely a rounding error somewhere in hardhat/js
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        amountStableSwappedIntoEstimated
      )
      // Volatile
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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

      const aliceVolBalanceAfter = await vol.balanceOf(alice.address)
      const aliceStableBalanceAfter = await dai.balanceOf(alice.address)

      const ownerLiquidityBalance = await pair.balanceOf(owner.address)
      await pair.transfer(alice.address, ownerLiquidityBalance)

      const liqNumer = 9900000
      const liqDenom = 10000000
      const aliceLiquidityWithdraw = ownerLiquidityBalance
        .mul(liqNumer)
        .div(liqDenom)

      const totalLpSupplyAfterDeposit = await pair.totalSupply()

      const amountStableFromLending = amountStableSwappedIntoEstimated
        .mul(aliceLiquidityWithdraw)
        .div(totalLpSupplyAfterDeposit)
      const withdrawSwapAmountsEstimated = await uniV2Router.getAmountsOut(
        amountStableFromLending,
        [dai.address, vol.address]
      )
      const amountVolSwapped =
        withdrawSwapAmountsEstimated[withdrawSwapAmountsEstimated.length - 1]
      const amountVolToRepay = (
        await cVol.callStatic.borrowBalanceCurrent(pair.address)
      )
        .mul(aliceLiquidityWithdraw)
        .div(totalLpSupplyAfterDeposit)
      const amountUniLpToWithdraw = (
        await cUniLp.callStatic.balanceOfUnderlying(pair.address)
      )
        .mul(aliceLiquidityWithdraw)
        .div(totalLpSupplyAfterDeposit)

      let amountStableFromWithdraw
      let amountVolFromWithdraw = BigNumber.from(0)

      if (amountVolToRepay <= amountVolSwapped) {
        amountStableFromWithdraw = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
          .mul(amountUniLpToWithdraw)
          .div(await uniLp.totalSupply())
        amountVolFromWithdraw = (await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
          .mul(amountUniLpToWithdraw)
          .div(await uniLp.totalSupply())
      } else {
        const amountStableFromLp = (await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
          .mul(amountUniLpToWithdraw)
          .div(await uniLp.totalSupply())
        const amountVolFromLp = (await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
          .mul(amountUniLpToWithdraw)
          .div(await uniLp.totalSupply())
        const amountVolToSwap = amountVolFromLp
          .add(amountVolSwapped)
          .sub(amountVolToRepay)
        const amountStableSwapped = await uniV2Router.getAmountsOut(
          amountVolToSwap,
          [vol.address, dai.address]
        )
        amountStableFromWithdraw = amountStableFromLp.add(
          amountStableSwapped[amountStableSwapped.length - 1]
        )
      }

      tx = await pair.connect(alice).withdraw(aliceLiquidityWithdraw, {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      })
      receipt = await tx.wait()

      // factory, pair, cTokens, owner, alice
      expect(await pair.totalSupply()).to.equal(
        ethers.BigNumber.from(MINIMUM_LIQUIDITY).add(
          ownerLiquidityBalance.sub(aliceLiquidityWithdraw)
        )
      )

      // Stable
      expect(await dai.balanceOf(factory.address)).to.equal(0)
      expect(await dai.balanceOf(pair.address)).to.equal(0)
      expect(await dai.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.sub(amountStable).sub(amountsStableToVol[0])
      )
      const aliceStableBalanceEnd = aliceStableBalanceAfter.add(
        amountStableFromWithdraw
      )
      equalTol(await dai.balanceOf(alice.address), aliceStableBalanceEnd)
      const cStableLeft = amountStable.sub(
        amountStable.mul(liqNumer).div(liqDenom)
      )
      equalTol(
        await cStable.callStatic.balanceOfUnderlying(pair.address),
        cStableLeft
      )

      // Volatile
      expect(await vol.balanceOf(factory.address)).to.equal(0)
      expect(await vol.balanceOf(pair.address)).to.equal(0)
      expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
      const aliceVolBalanceEnd = aliceVolBalanceAfter.add(amountVolFromWithdraw)
      equalTol(await vol.balanceOf(alice.address), aliceVolBalanceEnd)
      const cVolLeft = amountVol.sub(
        amountVol.mul(aliceLiquidityWithdraw).div(totalLpSupplyAfterDeposit)
      )
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        cVolLeft
      )

      // Uniswap LP token
      expect(await uniLp.balanceOf(factory.address)).to.equal(0)
      expect(await uniLp.balanceOf(pair.address)).to.equal(0)
      expect(await uniLp.balanceOf(owner.address)).to.equal(0)
      expect(await uniLp.balanceOf(alice.address)).to.equal(0)
      const amountUniLpLent = await cUniLp.callStatic.balanceOfUnderlying(
        pair.address
      )
      const estimatedAmountUniLpLent = amountUniLp
        .mul(liqDenom - liqNumer)
        .div(liqDenom)
      equalTol(amountUniLpLent, estimatedAmountUniLpLent)

      // AutoHedge LP token
      expect(await pair.balanceOf(factory.address)).to.equal(0)
      expect(await pair.balanceOf(pair.address)).to.equal(MINIMUM_LIQUIDITY)
      expect(await pair.balanceOf(owner.address)).to.equal(0)
      expect(await pair.balanceOf(alice.address)).to.equal(
        ownerLiquidityBalance.sub(aliceLiquidityWithdraw)
      )
    })
  })

  it("Should rebalance, borrow more ETH, no fee", async function () {
    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await vol.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    const testSnapshotId2 = await snapshot()

    await dai.approve(uniV2Router.address, amountStableInit)
    await vol.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, vol.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, vol.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      vol.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        vol.address,
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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
    expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
    await expect(pair.rebalance(false)).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    // Increase the amount of ETH held in the DEX
    const wethInUniBeforeTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
    const amountWethSell = parseEther("1000")
    await vol.connect(bob).approve(uniV2Router.address, amountWethSell)
    await uniV2Router
      .connect(bob)
      .swapExactTokensForTokens(
        amountWethSell,
        1,
        [vol.address, dai.address],
        bob.address,
        TEN_18
      )

    const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
    const { owned, debt, bps } =
      await pair.callStatic.getDebtBps()

    expect(wethInUniAfterTrade).gt(wethInUniBeforeTrade)
    const uniLpTotalSupply = await uniLp.totalSupply()
    const ahUniLpOwned = await cUniLp.callStatic.balanceOfUnderlying(
      pair.address
    )
    expect(owned).equal(
      wethInUniAfterTrade.mul(ahUniLpOwned).div(uniLpTotalSupply)
    )
    expect(debt).equal(
      await cVol.callStatic.borrowBalanceCurrent(pair.address)
    )
    expect(bps).equal(debt.mul(TEN_18).div(owned))

    const estStableFromVol = (
      await uniV2Router.getAmountsOut(owned.sub(debt), [
        vol.address,
        dai.address,
      ])
    )[1]

    await pair.rebalance(false)

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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
    equalTol(
      await cVol.callStatic.borrowBalanceCurrent(pair.address),
      owned
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

  it("Is delta-neutral e2e with Autonomy, ETH price lowering 10 times, pay fee from position", async function () {
    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await vol.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    const testSnapshotId2 = await snapshot()

    await dai.approve(uniV2Router.address, amountStableInit)
    await vol.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, vol.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, vol.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      vol.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        vol.address,
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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
    expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
    await expect(pair.rebalance(false)).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    const halfWithdrawAmountInit = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("Initial DAI amount if withdrawing half liquidity: ", halfWithdrawAmountInit)
    const uniLpTotalSupply = await uniLp.totalSupply()
    await vol.connect(priceCoordinator).approve(uniV2Router.address, constants.MaxUint256)
    const priceOfEthInit = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const rebalanceAutoCallData = pair.interface.encodeFunctionData("rebalanceAuto", [pair.address, 0])
    const req = {
      user: pair.address,
      target: pair.address,
      referer: constants.AddressZero,
      callData: rebalanceAutoCallData,
      initEthSent: 0,
      ethForCall: 0,
      verifyUser: true,
      insertFeeAmount: true,
      payWithAUTO: false,
      isAlive: true
    }

    // Repeatedly lower the price of ETH by 1% and rebalance
    for (let i = 0; i < 10; i++) {
      // Increase the amount of ETH held in the DEX
      const wethInUniBeforeTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const amountWethSell = wethInUniBeforeTrade.mul(110).div(10000)
      await uniV2Router
        .connect(priceCoordinator)
        .swapExactTokensForTokens(
          amountWethSell,
          1,
          [vol.address, dai.address],
          priceCoordinator.address,
          TEN_18
        )
      
      const gasEstimate = await registry.callStatic.executeHashedReq(AUTO_ID, req, MIN_GAS)
      const execTx = await registry.executeHashedReq(AUTO_ID, req, gasEstimate)

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      expect(wethInUniAfterTrade).gt(wethInUniBeforeTrade)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        wethInUniAfterTrade.mul(amountUniLp).div(uniLpTotalSupply)
      )
    }

    const halfWithdrawAmountAfter = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("DAI amount if withdrawing half liquidity after 10% ETH price decrease: ", halfWithdrawAmountAfter)

    const priceOfEthAfter = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const withdrawFactorDiff = TEN_18.sub(halfWithdrawAmountAfter.mul(TEN_18).div(halfWithdrawAmountInit))
    console.log("withdrawFactorDiff = ", withdrawFactorDiff, withdrawFactorDiff.mul(100).div(TEN_18))
    const priceFactorDiff = TEN_18.sub(priceOfEthAfter.mul(TEN_18).div(priceOfEthInit))
    console.log("priceFactorDiff = ", priceFactorDiff, priceFactorDiff.mul(100).div(TEN_18))
    const driftFactor = priceFactorDiff.mul(TEN_18).div(withdrawFactorDiff)
    console.log("driftFactor = ", driftFactor, driftFactor.mul(100).div(TEN_18))
  })

  it("Is delta-neutral e2e with Autonomy, ETH price lowering 10 times, pay fee from bal", async function () {
    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await vol.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    const testSnapshotId2 = await snapshot()

    await dai.approve(uniV2Router.address, amountStableInit)
    await vol.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, vol.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, vol.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      vol.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        vol.address,
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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
    expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
    await expect(pair.rebalance(false)).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    const halfWithdrawAmountInit = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("Initial DAI amount if withdrawing half liquidity: ", halfWithdrawAmountInit)
    const uniLpTotalSupply = await uniLp.totalSupply()
    await vol.connect(priceCoordinator).approve(uniV2Router.address, constants.MaxUint256)
    const priceOfEthInit = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const rebalanceAutoCallData = pair.interface.encodeFunctionData("rebalanceAuto", [pair.address, 0])
    const req = {
      user: pair.address,
      target: pair.address,
      referer: constants.AddressZero,
      callData: rebalanceAutoCallData,
      initEthSent: 0,
      ethForCall: 0,
      verifyUser: true,
      insertFeeAmount: true,
      payWithAUTO: false,
      isAlive: true
    }

    await owner.sendTransaction({to: pair.address, value: TEN_18})
    
    // Repeatedly lower the price of ETH by 1% and rebalance
    for (let i = 0; i < 10; i++) {
      // Increase the amount of ETH held in the DEX
      const wethInUniBeforeTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const amountWethSell = wethInUniBeforeTrade.mul(110).div(10000)
      await uniV2Router
        .connect(priceCoordinator)
        .swapExactTokensForTokens(
          amountWethSell,
          1,
          [vol.address, dai.address],
          priceCoordinator.address,
          TEN_18
        )
      
      const gasEstimate = await registry.callStatic.executeHashedReq(AUTO_ID, req, MIN_GAS)
      const execTx = await registry.executeHashedReq(AUTO_ID, req, gasEstimate)

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      expect(wethInUniAfterTrade).gt(wethInUniBeforeTrade)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        wethInUniAfterTrade.mul(amountUniLp).div(uniLpTotalSupply)
      )
    }

    const halfWithdrawAmountAfter = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("DAI amount if withdrawing half liquidity after 10% ETH price decrease: ", halfWithdrawAmountAfter)

    const priceOfEthAfter = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const withdrawFactorDiff = TEN_18.sub(halfWithdrawAmountAfter.mul(TEN_18).div(halfWithdrawAmountInit))
    console.log("withdrawFactorDiff = ", withdrawFactorDiff, withdrawFactorDiff.mul(100).div(TEN_18))
    const priceFactorDiff = TEN_18.sub(priceOfEthAfter.mul(TEN_18).div(priceOfEthInit))
    console.log("priceFactorDiff = ", priceFactorDiff, priceFactorDiff.mul(100).div(TEN_18))
    const driftFactor = priceFactorDiff.mul(TEN_18).div(withdrawFactorDiff)
    console.log("driftFactor = ", driftFactor, driftFactor.mul(100).div(TEN_18))
  })

  it("Is delta-neutral e2e with Autonomy, ETH price rising 10 times, pay fee from position", async function () {
    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await vol.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    const testSnapshotId2 = await snapshot()

    await dai.approve(uniV2Router.address, amountStableInit)
    await vol.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, vol.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, vol.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      vol.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        vol.address,
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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
    expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
    await expect(pair.rebalance(false)).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    const halfWithdrawAmountInit = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("Initial DAI amount if withdrawing half liquidity: ", halfWithdrawAmountInit)
    const uniLpTotalSupply = await uniLp.totalSupply()
    await dai.connect(priceCoordinator).approve(uniV2Router.address, constants.MaxUint256)
    const priceOfEthInit = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const rebalanceAutoCallData = pair.interface.encodeFunctionData("rebalanceAuto", [pair.address, 0])
    const req = {
      user: pair.address,
      target: pair.address,
      referer: constants.AddressZero,
      callData: rebalanceAutoCallData,
      initEthSent: 0,
      ethForCall: 0,
      verifyUser: true,
      insertFeeAmount: true,
      payWithAUTO: false,
      isAlive: true
    }

    // Repeatedly raise the price of ETH by 1% and rebalance
    for (let i = 0; i < 10; i++) {
      // Increase the amount of ETH held in the DEX
      const wethInUniBeforeTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const amountWethBuy = wethInUniBeforeTrade.mul(110).div(10000)
      await uniV2Router
        .connect(priceCoordinator)
        .swapTokensForExactTokens(
          amountWethBuy,
          constants.MaxUint256,
          [dai.address, vol.address],
          priceCoordinator.address,
          TEN_18
        )
      
      const gasEstimate = await registry.callStatic.executeHashedReq(AUTO_ID, req, MIN_GAS)
      const execTx = await registry.executeHashedReq(AUTO_ID, req, gasEstimate)

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      expect(wethInUniAfterTrade).lt(wethInUniBeforeTrade)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        wethInUniAfterTrade.mul(amountUniLp).div(uniLpTotalSupply)
      )
    }

    const halfWithdrawAmountAfter = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("DAI amount if withdrawing half liquidity after 10% ETH price increase: ", halfWithdrawAmountAfter)

    const priceOfEthAfter = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const withdrawFactorDiff = TEN_18.sub(halfWithdrawAmountAfter.mul(TEN_18).div(halfWithdrawAmountInit))
    console.log("withdrawFactorDiff = ", withdrawFactorDiff, withdrawFactorDiff.mul(100).div(TEN_18))
    const priceFactorDiff = TEN_18.sub(priceOfEthAfter.mul(TEN_18).div(priceOfEthInit))
    console.log("priceFactorDiff = ", priceFactorDiff, priceFactorDiff.mul(100).div(TEN_18))
    const driftFactor = priceFactorDiff.mul(TEN_18).div(withdrawFactorDiff)
    console.log("driftFactor = ", driftFactor, driftFactor.mul(100).div(TEN_18))
  })

  it("Is delta-neutral e2e with Autonomy, ETH price rising 10 times", async function () {
    const amountStableInit = parseEther(String(1.1 * ethPrice * 2)) // fuse min borrow amount is 1 ETH, and half is kept as DAI
    const amountVolZapMin = parseEther("1")
    const amountStableMin = 0
    const amountVolMin = 0
    const swapAmountOutMin = 0

    const wethBalanceBefore = await vol.balanceOf(owner.address)
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    // To estimate the amount LP'd on Uniswap with, we need to know what the reserves of the pair is, which is
    // altered before LPing because we trade stable to vol in the same pair probably, so need to make the trade
    // 1st to measure the reserves after
    const testSnapshotId2 = await snapshot()

    await dai.approve(uniV2Router.address, amountStableInit)
    await vol.approve(uniV2Router.address, amountStableInit)
    const amountsStableToVol = await uniV2Router.getAmountsOut(
      amountStableInit.div(2),
      [dai.address, vol.address]
    )
    const amountVolEstimated = amountsStableToVol[1]
    await uniV2Router.swapExactTokensForTokens(
      amountStableInit.sub(amountsStableToVol[0]),
      1,
      [dai.address, vol.address],
      owner.address,
      TEN_18
    )
    const amountStableEstimated = amountVolEstimated
      .mul(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await vol.balanceOf(UNIV2_DAI_ETH_ADDR))
    await uniV2Router.addLiquidity(
      dai.address,
      vol.address,
      amountStableEstimated,
      amountVolEstimated,
      1,
      1,
      owner.address,
      TEN_18
    )
    const amountStableSwappedIntoEstimated = (
      await uniV2Router.getAmountsOut(amountVolEstimated, [
        vol.address,
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
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
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
    expect(wethBalanceBefore).to.equal(await vol.balanceOf(owner.address))
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
    expect(await vol.balanceOf(factory.address)).to.equal(0)
    expect(await vol.balanceOf(pair.address)).to.equal(0)
    expect(await vol.balanceOf(owner.address)).to.equal(wethBalanceBefore)
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
    await expect(pair.rebalance(false)).to.be.revertedWith(REV_MSG_WITHIN_RANGE)

    const halfWithdrawAmountInit = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("Initial DAI amount if withdrawing half liquidity: ", halfWithdrawAmountInit)
    const uniLpTotalSupply = await uniLp.totalSupply()
    await dai.connect(priceCoordinator).approve(uniV2Router.address, constants.MaxUint256)
    const priceOfEthInit = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const rebalanceAutoCallData = pair.interface.encodeFunctionData("rebalanceAuto", [pair.address, 0])
    const req = {
      user: pair.address,
      target: pair.address,
      referer: constants.AddressZero,
      callData: rebalanceAutoCallData,
      initEthSent: 0,
      ethForCall: 0,
      verifyUser: true,
      insertFeeAmount: true,
      payWithAUTO: false,
      isAlive: true
    }

    await owner.sendTransaction({to: pair.address, value: TEN_18})
    
    // Repeatedly raise the price of ETH by 1% and rebalance
    for (let i = 0; i < 10; i++) {
      // Increase the amount of ETH held in the DEX
      const wethInUniBeforeTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      const amountWethBuy = wethInUniBeforeTrade.mul(110).div(10000)
      await uniV2Router
        .connect(priceCoordinator)
        .swapTokensForExactTokens(
          amountWethBuy,
          constants.MaxUint256,
          [dai.address, vol.address],
          priceCoordinator.address,
          TEN_18
        )
      
      const gasEstimate = await registry.callStatic.executeHashedReq(AUTO_ID, req, MIN_GAS)
      const execTx = await registry.executeHashedReq(AUTO_ID, req, gasEstimate)

      const wethInUniAfterTrade = await vol.balanceOf(UNIV2_DAI_ETH_ADDR)
      expect(wethInUniAfterTrade).lt(wethInUniBeforeTrade)
      equalTol(
        await cVol.callStatic.borrowBalanceCurrent(pair.address),
        wethInUniAfterTrade.mul(amountUniLp).div(uniLpTotalSupply)
      )
    }

    const halfWithdrawAmountAfter = await pair.callStatic.withdraw(
      ownerLiquidityBalance.div(2), {
        amountStableMin,
        amountVolMin,
        deadline: noDeadline,
        pathStableToVol: [dai.address, vol.address],
        pathVolToStable: [vol.address, dai.address],
        swapAmountOutMin,
      }
    )
    console.log("DAI amount if withdrawing half liquidity after 10% ETH price increase: ", halfWithdrawAmountAfter)

    const priceOfEthAfter = (
      await uniV2Router.getAmountsOut(TEN_18, [
        vol.address,
        dai.address,
      ])
    )[1]

    const withdrawFactorDiff = TEN_18.sub(halfWithdrawAmountAfter.mul(TEN_18).div(halfWithdrawAmountInit))
    console.log("withdrawFactorDiff = ", withdrawFactorDiff, withdrawFactorDiff.mul(100).div(TEN_18))
    const priceFactorDiff = TEN_18.sub(priceOfEthAfter.mul(TEN_18).div(priceOfEthInit))
    console.log("priceFactorDiff = ", priceFactorDiff, priceFactorDiff.mul(100).div(TEN_18))
    const driftFactor = priceFactorDiff.mul(TEN_18).div(withdrawFactorDiff)
    console.log("driftFactor = ", driftFactor, driftFactor.mul(100).div(TEN_18))
  })

  // TODO: test rebalance with a fee
  // TODO: test big rebalance value such that it's out of balance after rebalancing
  // TODO: test deposit with large enough deposit for the debt to be out of sync at the end
  // TODO: test withdraw with large enough withdraw for the debt to be out of sync at the end
  // TODO: test that the rebalance condition isn't triggered by people adding liquidity
  // TODO: test rebalance with non-ETH asset
})