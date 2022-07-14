import { ethers, network } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, constants, ContractReceipt, Event, utils } from "ethers"

import {
  MasterPriceOracle,
  UniswapV2Router02,
  Unitroller,
  WETH,
} from "typechain/thirdparty"
import {
  DeltaNeutralStableVolatileFactoryUpgradeable,
  DeltaNeutralStableVolatilePairUpgradeable,
  ICErc20,
  IERC20,
  UBeacon,
  Registry,
  TProxyAdmin,
  TProxy,
  FlashloanWrapper,
  UUPSProxy,
  AutoHedgeLeveragedPosition,
  BeaconProxy,
  AutoHedgeLeveragedPositionFactory,
  MockSqrt,
} from "typechain"

import {
  getAddresses,
  UnitrollerSnapshot,
  ArtifactType,
  snapshot,
  revertSnapshot,
  noDeadline,
  defaultDepositEvent,
  CERC20_IMPLEMENTATION_ADDR,
  defaultFlashLoanEvent,
  defaultFlashLoanRepaidEvent,
  MINIMUM_LIQUIDITY,
  defaultWithdrawLevEvent,
  equalTol,
  impersonateAccount,
} from "../scripts/utils"

import FusePoolLensAbi from "../thirdparty/FusePoolLens.json"
import MasterPriceOracleAbi from "../thirdparty/MasterPriceOracle.json"
import ICErc20Abi from "../artifacts/interfaces/ICErc20.sol/ICErc20.json"
import WETHAbi from "../thirdparty/WETH.json"
import DAI from "../thirdparty/DAI.json"
import UniswapV2Router02Abi from "../thirdparty/UniswapV2Router02.json"
import UnitrollerAbi from "../thirdparty/Unitroller.json"

const { parseEther, formatEther } = utils

const TEN_18 = parseEther("1")
const AUTO_ID = 0
const FLASH_LOAN_FEE = 50 // 0.05%
const FLASH_LOAN_FEE_PRECISION = 1e5
const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
const UNIV2_DAI_ETH_ADDR = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11"
const SUSHI_BENTOBOX_ADDR = "0xF5BCE5077908a1b7370B9ae04AdC565EBd643966"

describe("AutoHedgeLeveragedPosition", () => {
  let addresses: UnitrollerSnapshot

  let owner: SignerWithAddress
  let alice: SignerWithAddress
  let feeReceiver: SignerWithAddress

  let weth: WETH
  let dai: IERC20
  let uniV2Router: UniswapV2Router02
  let uniLp: IERC20
  let cVol: ICErc20
  let cStable: ICErc20
  let cUniLp: ICErc20
  let cAhlp: ICErc20

  let factory: DeltaNeutralStableVolatileFactoryUpgradeable
  let pair: DeltaNeutralStableVolatilePairUpgradeable
  let masterPriceOracle: MasterPriceOracle
  let flw: FlashloanWrapper
  let ahlp: AutoHedgeLeveragedPosition
  let ahlpFactory: AutoHedgeLeveragedPositionFactory
  let mockSqrt: MockSqrt

  let admin: TProxyAdmin
  let factoryProxy: TProxy
  let pairImpl: DeltaNeutralStableVolatilePairUpgradeable
  let unitroller: Unitroller
  let comptroller: string
  let levTokens

  let registry: Registry

  let testSnapshotId: string
  let allTimeTestSnapshotId: string

  const c = (artifact: ArtifactType) =>
    new ethers.Contract(artifact.address, artifact.abi, owner)

  async function deployAutoHedge() {
    addresses = getAddresses()
    comptroller = addresses.unitroller

    weth = <WETH>c(WETHAbi)
    dai = <IERC20>c(DAI)
    uniV2Router = <UniswapV2Router02>c(UniswapV2Router02Abi)

    // It's fucking dumb that BigNumber doesn't support sqrt operations -.- need to mock using the sqrt used in Solidity
    const MockSqrtFactory = await ethers.getContractFactory("MockSqrt")
    const TProxyAdminFactory = await ethers.getContractFactory("TProxyAdmin")
    const TProxyFactory = await ethers.getContractFactory("TProxy")
    const UBeaconFactory = await ethers.getContractFactory("UBeacon")
    const DeltaNeutralStableVolatileFactoryUpgradeableFactory =
      await ethers.getContractFactory(
        "DeltaNeutralStableVolatileFactoryUpgradeable"
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
    const beacon = <UBeacon>await UBeaconFactory.deploy(pairImpl.address)
    const factoryImpl = <DeltaNeutralStableVolatileFactoryUpgradeable>(
      await DeltaNeutralStableVolatileFactoryUpgradeableFactory.deploy()
    )
    factoryProxy = <TProxy>await TProxyFactory.deploy(
      factoryImpl.address,
      admin.address,
      factoryImpl.interface.encodeFunctionData("initialize", [
        beacon.address,
        weth.address,
        UNIV2_FACTORY_ADDR,
        uniV2Router.address,
        comptroller,
        addresses.reg,
        addresses.uff,
        {
          min: parseEther("0.99"),
          max: parseEther("1.01"),
        },
        feeReceiver.address,
      ])
    )
    factory = <DeltaNeutralStableVolatileFactoryUpgradeable>(
      await DeltaNeutralStableVolatileFactoryUpgradeableFactory.attach(
        factoryProxy.address
      )
    )

    const tx = await factory.createPair(dai.address, weth.address)
    const receipt = await tx.wait()
    const lastEvent = receipt.events?.pop()
    const pairAddress = lastEvent ? lastEvent.args?.pair : ""

    expect(await factory.depositFee()).equal(parseEther("0.003"))

    pair = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.attach(pairAddress)
    )

    expect(await pair.factory()).equal(factory.address)

    registry = <Registry>await RegistryFactory.attach(addresses.reg)

    // expect(await pair.autoId()).equal(AUTO_ID)

    const tokens = await pair.tokens()
    uniLp = <IERC20>new ethers.Contract(tokens.uniLp, WETHAbi.abi, owner)
    cVol = <ICErc20>new ethers.Contract(tokens.cVol, ICErc20Abi.abi, owner)
    cStable = <ICErc20>(
      new ethers.Contract(tokens.cStable, ICErc20Abi.abi, owner)
    )
    cUniLp = <ICErc20>new ethers.Contract(tokens.cUniLp, ICErc20Abi.abi, owner)

    unitroller = <Unitroller>(
      new ethers.Contract(comptroller, UnitrollerAbi.abi, owner)
    )

    masterPriceOracle = <MasterPriceOracle>(
      new ethers.Contract(addresses.oracle, MasterPriceOracleAbi.abi, owner)
    )
    // TODO make a separate Price Oracle for AHLP
    const ahOracle = await (
      await ethers.getContractFactory("AutoHedgeDummyOracle")
    ).deploy(weth.address)
    await owner.sendTransaction({
      value: parseEther("10"),
      to: ahOracle.address,
    })
    await masterPriceOracle.add([pair.address], [ahOracle.address])

    const reserveFactor = ethers.BigNumber.from("100000000000000000")
    const collateralFactorMantissa = ethers.BigNumber.from("700000000000000000")
    const constructorTypes = [
      "address",
      "address",
      "address",
      "string",
      "string",
      "address",
      "bytes",
      "uint256",
      "uint256",
    ]

    await unitroller._deployMarket(
      false,
      ethers.utils.defaultAbiCoder.encode(constructorTypes, [
        pair.address,
        unitroller.address,
        "0xc35DB333EF7ce4F246DE9DE11Cc1929d6AA11672",
        "DAI ETH AHLP",
        "fAH-DAI-ETH-185",
        CERC20_IMPLEMENTATION_ADDR,
        0x00,
        reserveFactor,
        0,
      ]),
      collateralFactorMantissa
    )

    cAhlp = <ICErc20>(
      new ethers.Contract(
        await unitroller.cTokensByUnderlying(pair.address),
        ICErc20Abi.abi,
        owner
      )
    )
    levTokens = {
      ...tokens,
      pair: pair.address,
      cAhlp: cAhlp.address,
    }
  }

  async function deployFlashLoanWrapper() {
    const FlashloanWrapperFactory = await ethers.getContractFactory(
      "FlashloanWrapper"
    )
    const flwImpl = <FlashloanWrapper>await FlashloanWrapperFactory.deploy()
    const UUPSProxyFactory = await ethers.getContractFactory("UUPSProxy")
    const flwProxy = <UUPSProxy>(
      await UUPSProxyFactory.deploy(
        flwImpl.address,
        flwImpl.interface.encodeFunctionData("initialize", [
          SUSHI_BENTOBOX_ADDR,
        ])
      )
    )
    flw = <FlashloanWrapper>(
      await FlashloanWrapperFactory.attach(flwProxy.address)
    )

    expect(await flw.sushiBentoBox()).to.equal(SUSHI_BENTOBOX_ADDR)
  }

  async function deployAutoHedgeLeveragedPosition() {
    const AHLPFactory = await ethers.getContractFactory(
      "AutoHedgeLeveragedPosition"
    )
    const ahlpImpl = <AutoHedgeLeveragedPosition>await AHLPFactory.deploy()
    const UBeaconFactory = await ethers.getContractFactory("UBeacon")
    const beacon = <UBeacon>await UBeaconFactory.deploy(ahlpImpl.address)

    const AutoHedgeLeveragedPositionFactoryFactory =
      await ethers.getContractFactory("AutoHedgeLeveragedPositionFactory")
    const ahlpFactoryImpl = <AutoHedgeLeveragedPositionFactory>(
      await AutoHedgeLeveragedPositionFactoryFactory.deploy()
    )

    const UUPSProxyFactory = await ethers.getContractFactory("UUPSProxy")
    const ahlpFactoryProxy = <UUPSProxy>(
      await UUPSProxyFactory.deploy(
        ahlpFactoryImpl.address,
        ahlpFactoryImpl.interface.encodeFunctionData("initialize", [
          beacon.address,
          flw.address,
        ])
      )
    )

    ahlpFactory = <AutoHedgeLeveragedPositionFactory>(
      AutoHedgeLeveragedPositionFactoryFactory.attach(ahlpFactoryProxy.address)
    )

    const tx = await ahlpFactory.createLeveragedPosition()

    const receipt = await tx.wait()
    const lastEvent = receipt.events?.pop()
    const lvgPos = lastEvent ? lastEvent.args?.lvgPos : ""

    ahlp = <AutoHedgeLeveragedPosition>AHLPFactory.attach(lvgPos)

    expect(await ahlpFactory.flw()).to.equal(flw.address)
    expect(await ahlp.factory()).to.equal(ahlpFactory.address)

    await weth.approve(ahlp.address, constants.MaxUint256)
    await dai.approve(ahlp.address, constants.MaxUint256)
  }

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

  async function estimateDeposit(amountStableInit: BigNumber) {
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

    return {
      amountsStableToVol,
      amountVolEstimated,
      amountStableEstimated,
      amountStableSwappedIntoEstimated,
    }
  }

  function getDepositEvent(receipt: ContractReceipt) {
    const depositedEventByName = receipt.events?.find(
      ({ event }) => event === "Deposited"
    )
    if (depositedEventByName?.args) {
      return depositedEventByName.args
    }

    const depositedEventTopic = utils.id(
      "Deposited(address,uint256,uint256,uint256,uint256,uint256)"
    )
    const depositedEventsByTopic: Event[] | undefined = receipt.events?.filter(
      ({ topics }) => topics.includes(depositedEventTopic)
    )
    if (!depositedEventsByTopic || depositedEventsByTopic.length === 0) {
      return defaultDepositEvent
    }
    const depositedEvent = depositedEventsByTopic[0]

    const abi = [
      "event Deposited(address indexed user, uint amountStable, uint amountVol, uint amountUniLp, uint amountStableSwap, uint amountMinted)",
    ]
    const iface = new utils.Interface(abi)
    const {
      args: { amountStable, amountVol, amountUniLp },
    } = iface.parseLog(depositedEvent)
    return {
      amountStable,
      amountUniLp,
      amountVol,
    }
  }

  function getFlashLoanEvent(receipt: ContractReceipt) {
    const flashloanEventByName = receipt.events?.find(
      ({ event }) => event === "FlashLoan"
    )
    if (flashloanEventByName?.args) {
      return flashloanEventByName.args
    }

    const flashLoanEventTopic = utils.id(
      "FlashLoan(address,address,uint256,uint256,uint256)"
    )
    const flashLoanEventsByTopic: Event[] | undefined = receipt.events?.filter(
      ({ topics }) => topics.includes(flashLoanEventTopic)
    )
    if (!flashLoanEventsByTopic || flashLoanEventsByTopic.length === 0) {
      return defaultFlashLoanEvent
    }
    const flashLoanEvent = flashLoanEventsByTopic[0]

    const abi = [
      "event FlashLoan(address indexed receiver,address token,uint256 amount,uint256 fee,uint256 loanType)",
    ]
    const iface = new utils.Interface(abi)
    const {
      args: { receiver, token, amount, fee, loanType },
    } = iface.parseLog(flashLoanEvent)
    return {
      receiver,
      token,
      amount,
      fee,
      loanType,
    }
  }

  function getFlashLoanRepaidEvent(receipt: ContractReceipt) {
    const flashloanRepaidEventByName = receipt.events?.find(
      ({ event }) => event === "FlashLoanRepaid"
    )
    if (flashloanRepaidEventByName?.args) {
      return flashloanRepaidEventByName.args
    }

    const flashLoanRepaidEventTopic = utils.id(
      "FlashLoanRepaid(address,uint256)"
    )
    const flashLoanRepaidEventsByTopic: Event[] | undefined =
      receipt.events?.filter(({ topics }) =>
        topics.includes(flashLoanRepaidEventTopic)
      )
    if (
      !flashLoanRepaidEventsByTopic ||
      flashLoanRepaidEventsByTopic.length === 0
    ) {
      return defaultFlashLoanRepaidEvent
    }
    const flashLoanRepaidEvent = flashLoanRepaidEventsByTopic[0]

    const abi = ["event FlashLoanRepaid(address indexed to,uint256 amount)"]
    const iface = new utils.Interface(abi)
    const {
      args: { to, amount },
    } = iface.parseLog(flashLoanRepaidEvent)
    return {
      to,
      amount,
    }
  }

  async function increaseUniLpPrice() {
    await weth.connect(alice).approve(uniV2Router.address, constants.MaxUint256)
    await dai.connect(alice).approve(uniV2Router.address, constants.MaxUint256)

    const amountStableToTrade = parseEther("1000000") // 1M
    const amountVolTradeEstimated = amountStableToTrade
      .mul(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))
      .div(await dai.balanceOf(UNIV2_DAI_ETH_ADDR))

    let poolStableBalance = await dai.balanceOf(UNIV2_DAI_ETH_ADDR)
    let poolVolBalance = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)
    const poolVolPriceBefore = poolStableBalance.div(poolVolBalance)
    const poolValueBefore = poolStableBalance.add(
      poolVolBalance.mul(poolVolPriceBefore)
    )
    let poolValueAfter

    while (true) {
      let poolVolPriceBeforeBuyStable = (
        await dai.balanceOf(UNIV2_DAI_ETH_ADDR)
      ).div(await weth.balanceOf(UNIV2_DAI_ETH_ADDR))

      // Swap WETH for 1M DAI
      await uniV2Router
        .connect(alice)
        .swapExactTokensForTokens(
          amountVolTradeEstimated,
          1,
          [weth.address, dai.address],
          alice.address,
          TEN_18
        )

      // Get the updated price
      poolStableBalance = await dai.balanceOf(UNIV2_DAI_ETH_ADDR)
      poolVolBalance = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)

      let poolVolPriceAfterBuyStable = poolStableBalance.div(poolVolBalance)
      expect(poolVolPriceAfterBuyStable).to.lt(poolVolPriceBeforeBuyStable)

      // Get K updated due to the swap fee
      const K = poolStableBalance.mul(poolVolBalance)

      // Swap DAI for WETH again to keep the original pool price
      let targetStableBalance = await mockSqrt.sqrt(K.mul(poolVolPriceBefore))
      let amountStableTradeEstimated =
        targetStableBalance.sub(poolStableBalance)
      await uniV2Router
        .connect(alice)
        .swapExactTokensForTokens(
          amountStableTradeEstimated,
          1,
          [dai.address, weth.address],
          alice.address,
          TEN_18
        )

      // Get the updated price
      poolStableBalance = await dai.balanceOf(UNIV2_DAI_ETH_ADDR)
      poolVolBalance = await weth.balanceOf(UNIV2_DAI_ETH_ADDR)

      let poolVolPriceAfterSellStable = poolStableBalance.div(poolVolBalance)
      equalTol(poolVolPriceAfterSellStable, poolVolPriceBefore)

      // get the updated pool value
      poolValueAfter = poolStableBalance.add(
        poolVolBalance.mul(poolVolPriceAfterSellStable)
      )

      // break if the pool value is increased by 1% by the swap fee
      if (poolValueAfter >= poolValueBefore.mul(101).div(100)) break
    }

    return {
      denominator: poolValueBefore,
      numerator: poolValueAfter,
    }
  }

  beforeEach(async () => {
    testSnapshotId = await snapshot()
  })

  afterEach(async () => {
    await revertSnapshot(testSnapshotId)
  })

  before(async () => {
    ;[owner, alice, feeReceiver] = await ethers.getSigners()

    allTimeTestSnapshotId = await snapshot()

    await deployAutoHedge()
    await deployFlashLoanWrapper()
    await deployAutoHedgeLeveragedPosition()
  })

  after(async () => {
    await revertSnapshot(allTimeTestSnapshotId)
  })

  describe("depositLev()", () => {
    it("should work as expected", async () => {
      const wethPrice = await getWETHPrice()
      const amountStableDeposit = parseEther(String(1.1 * wethPrice * 2))
      const amountVolZapMin = 0
      // 5x leverage
      const leverageRatio = parseEther("5")

      const ahDepositFee = await factory.depositFee()
      const ahConvRate = TEN_18.sub(ahDepositFee)
      const b = ahConvRate.mul(leverageRatio.sub(TEN_18)).div(leverageRatio)
      const c = TEN_18.mul(FLASH_LOAN_FEE_PRECISION - FLASH_LOAN_FEE).div(
        FLASH_LOAN_FEE_PRECISION
      )
      const amountStableFlashloan = amountStableDeposit.mul(b).div(c.sub(b))
      const amountToDepositToAH = amountStableDeposit.add(amountStableFlashloan)
      const { amountVolEstimated, amountStableEstimated } =
        await estimateDeposit(amountToDepositToAH)

      const tokens = await pair.tokens()

      const tx = await ahlp.depositLev(
        comptroller,
        {
          ...tokens,
          pair: pair.address,
          cAhlp: cAhlp.address,
        },
        amountVolZapMin,
        {
          amountStableMin: 0,
          amountVolMin: 0,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin: 0,
        },
        constants.AddressZero,
        amountStableDeposit,
        amountStableFlashloan,
        leverageRatio
      )
      const receipt = await tx.wait()

      const { amount: flashLoanAmount, fee: flashLoanFee } =
        getFlashLoanEvent(receipt)
      const { amount: flashLoanRepaidAmount } = getFlashLoanRepaidEvent(receipt)

      const totalLoan = flashLoanAmount.add(flashLoanFee)

      expect(flashLoanAmount).to.equal(amountStableFlashloan)
      expect(flashLoanRepaidAmount).to.equal(totalLoan)

      const { amountStable, amountVol } = getDepositEvent(receipt)

      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)

      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const liquidityFee = liquidity.mul(await factory.depositFee()).div(TEN_18)
      // Check if cAhlp token balance is correct
      expect(await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)).to.equal(
        liquidity.sub(liquidityFee)
      )
      // TODO do we need to make referrer fee as cToken?
      expect(await pair.balanceOf(feeReceiver.address)).to.equal(liquidityFee)
    })
  })

  describe("withdrawLev()", () => {
    it("should work as expected", async () => {
      const wethPrice = await getWETHPrice()
      const amountStableDeposit = parseEther(String(1.1 * wethPrice * 2))
      const amountVolZapMin = 0
      // 5x leverage
      const leverageRatio = parseEther("5")

      const ahDepositFee = await factory.depositFee()
      const ahConvRate = TEN_18.sub(ahDepositFee)
      const b = ahConvRate.mul(leverageRatio.sub(TEN_18)).div(leverageRatio)
      const c = TEN_18.mul(FLASH_LOAN_FEE_PRECISION - FLASH_LOAN_FEE).div(
        FLASH_LOAN_FEE_PRECISION
      )
      const amountStableFlashloan = amountStableDeposit.mul(b).div(c.sub(b))
      const amountToDepositToAH = amountStableDeposit.add(amountStableFlashloan)
      const { amountVolEstimated, amountStableEstimated } =
        await estimateDeposit(amountToDepositToAH)

      const tokens = await pair.tokens()

      let tx = await ahlp.depositLev(
        comptroller,
        {
          ...tokens,
          pair: pair.address,
          cAhlp: cAhlp.address,
        },
        amountVolZapMin,
        {
          amountStableMin: 0,
          amountVolMin: 0,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin: 0,
        },
        constants.AddressZero,
        amountStableDeposit,
        amountStableFlashloan,
        leverageRatio
      )
      let receipt = await tx.wait()

      const { amount: flashLoanAmount, fee: flashLoanFee } =
        getFlashLoanEvent(receipt)
      const { amount: flashLoanRepaidAmount } = getFlashLoanRepaidEvent(receipt)

      const totalLoan = flashLoanAmount.add(flashLoanFee)

      expect(flashLoanAmount).to.equal(amountStableFlashloan)
      expect(flashLoanRepaidAmount).to.equal(totalLoan)

      const { amountStable, amountVol } = getDepositEvent(receipt)

      expect(amountVol).to.equal(amountVolEstimated)
      expect(amountStable).to.equal(amountStableEstimated)

      const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
        MINIMUM_LIQUIDITY
      )
      const liquidityFee = liquidity.mul(await factory.depositFee()).div(TEN_18)
      // Check if cAhlp token balance is correct
      expect(await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)).to.equal(
        liquidity.sub(liquidityFee)
      )
      // TODO do we need to make referrer fee as cToken?
      expect(await pair.balanceOf(feeReceiver.address)).to.equal(liquidityFee)

      const amountAhlp = await cAhlp.callStatic.balanceOfUnderlying(
        ahlp.address
      )
      const amountAhlpRedeem = amountAhlp.div(3)
      const amountStableWithdraw = parseEther("1000")
      const amountStableRepay = amountStableWithdraw
        .mul(leverageRatio)
        .div(TEN_18)
        .mul(FLASH_LOAN_FEE_PRECISION)
        .div(FLASH_LOAN_FEE_PRECISION - FLASH_LOAN_FEE)

      const amountStableInLPBefore =
        await cStable.callStatic.balanceOfUnderlying(ahlp.address)
      const daiBalanceBefore = await dai.balanceOf(owner.address)

      tx = await ahlp.withdrawLev(
        {
          ...tokens,
          pair: pair.address,
          cAhlp: cAhlp.address,
        },
        {
          amountStableMin: 0,
          amountVolMin: 0,
          deadline: noDeadline,
          pathStableToVol: [dai.address, weth.address],
          pathVolToStable: [weth.address, dai.address],
          swapAmountOutMin: 0,
        },
        amountStableWithdraw,
        amountStableRepay,
        amountAhlpRedeem,
        leverageRatio
      )
      receipt = await tx.wait()

      const withdrawLevEvent = receipt.events?.find(
        ({ event }) => event === "WithdrawLev"
      )
      const withdrawLevArgs = withdrawLevEvent
        ? withdrawLevEvent.args
        : defaultWithdrawLevEvent

      expect(await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)).to.equal(
        amountAhlp.sub(amountAhlpRedeem)
      )
      expect(await dai.balanceOf(owner.address)).to.equal(
        daiBalanceBefore.add(amountStableWithdraw)
      )
      if (withdrawLevArgs?.amountStableExcess.gt(0)) {
        const amountStableInLPAfter =
          await cStable.callStatic.balanceOfUnderlying(ahlp.address)
        equalTol(
          amountStableInLPAfter,
          amountStableInLPBefore.add(withdrawLevArgs.amountStableExcess)
        )
      }
    })
  })

  it.only("should work as expected if there is 5% price change and leverage 10x", async () => {
    const wethPrice = await getWETHPrice()
    const amountStableDeposit = parseEther(String(1.1 * wethPrice * 2))
    const amountVolZapMin = 0
    // 10x leverage
    const leverageRatio = parseEther("10")

    const ahDepositFee = await factory.depositFee()
    const ahConvRate = TEN_18.sub(ahDepositFee)
    const b = ahConvRate.mul(leverageRatio.sub(TEN_18)).div(leverageRatio)
    const c = TEN_18.mul(FLASH_LOAN_FEE_PRECISION - FLASH_LOAN_FEE).div(
      FLASH_LOAN_FEE_PRECISION
    )
    const amountStableFlashloan = amountStableDeposit.mul(b).div(c.sub(b))
    const amountToDepositToAH = amountStableDeposit.add(amountStableFlashloan)
    const { amountVolEstimated, amountStableEstimated } = await estimateDeposit(
      amountToDepositToAH
    )
    const uniArgs = {
      amountStableMin: 0,
      amountVolMin: 0,
      deadline: noDeadline,
      pathStableToVol: [dai.address, weth.address],
      pathVolToStable: [weth.address, dai.address],
      swapAmountOutMin: 0,
    }

    const tokens = await pair.tokens()

    let tx = await ahlp.depositLev(
      comptroller,
      {
        ...tokens,
        pair: pair.address,
        cAhlp: cAhlp.address,
      },
      amountVolZapMin,
      uniArgs,
      constants.AddressZero,
      amountStableDeposit,
      amountStableFlashloan,
      leverageRatio
    )
    let receipt = await tx.wait()

    const { amount: flashLoanAmount, fee: flashLoanFee } =
      getFlashLoanEvent(receipt)
    const { amount: flashLoanRepaidAmount } = getFlashLoanRepaidEvent(receipt)

    const totalLoan = flashLoanAmount.add(flashLoanFee)

    expect(flashLoanAmount).to.equal(amountStableFlashloan)
    expect(flashLoanRepaidAmount).to.equal(totalLoan)

    const { amountStable, amountVol } = getDepositEvent(receipt)

    expect(amountVol).to.equal(amountVolEstimated)
    expect(amountStable).to.equal(amountStableEstimated)

    const liquidity = (await mockSqrt.sqrt(amountVol.mul(amountStable))).sub(
      MINIMUM_LIQUIDITY
    )
    const liquidityFee = liquidity.mul(await factory.depositFee()).div(TEN_18)
    // Check if cAhlp token balance is correct
    expect(await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)).to.equal(
      liquidity.sub(liquidityFee)
    )
    // TODO do we need to make referrer fee as cToken?
    expect(await pair.balanceOf(feeReceiver.address)).to.equal(liquidityFee)

    const amountAhlp = await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)
    const amountAhlpRedeem = amountAhlp.div(3)
    const amountStableWithdraw = parseEther("500")
    const amountStableRepay = amountStableWithdraw
      .mul(leverageRatio)
      .div(TEN_18)
      .mul(FLASH_LOAN_FEE_PRECISION)
      .div(FLASH_LOAN_FEE_PRECISION - FLASH_LOAN_FEE)

    const amountStableInLPBefore = await cStable.callStatic.balanceOfUnderlying(
      ahlp.address
    )
    const daiBalanceBefore = await dai.balanceOf(owner.address)

    const testSnapshotId2 = await snapshot()

    tx = await ahlp.withdrawLev(
      {
        ...tokens,
        pair: pair.address,
        cAhlp: cAhlp.address,
      },
      uniArgs,
      amountStableWithdraw,
      amountStableRepay,
      amountAhlpRedeem,
      leverageRatio
    )
    receipt = await tx.wait()

    let withdrawLevEvent = receipt.events?.find(
      ({ event }) => event === "WithdrawLev"
    )
    let withdrawLevArgs = withdrawLevEvent?.args
      ? withdrawLevEvent.args
      : defaultWithdrawLevEvent
    const amountStablesFromAhlpBefore = withdrawLevArgs.amountStableFlashloan
      .mul(FLASH_LOAN_FEE_PRECISION + FLASH_LOAN_FEE)
      .div(FLASH_LOAN_FEE_PRECISION)
      .add(withdrawLevArgs.amountStableExcess)
      .add(withdrawLevArgs.amountStableWithdraw)
    await revertSnapshot(testSnapshotId2)

    const { denominator: denom, numerator: numer } = await increaseUniLpPrice()

    await pair.rebalance(false)

    tx = await ahlp.withdrawLev(
      {
        ...tokens,
        pair: pair.address,
        cAhlp: cAhlp.address,
      },
      uniArgs,
      amountStableWithdraw,
      amountStableRepay,
      amountAhlpRedeem,
      leverageRatio
    )
    receipt = await tx.wait()

    withdrawLevEvent = receipt.events?.find(
      ({ event }) => event === "WithdrawLev"
    )
    withdrawLevArgs = withdrawLevEvent?.args
      ? withdrawLevEvent.args
      : defaultWithdrawLevEvent

    const amountStablesFromAhlpAfter = withdrawLevArgs.amountStableFlashloan
      .mul(FLASH_LOAN_FEE_PRECISION + FLASH_LOAN_FEE)
      .div(FLASH_LOAN_FEE_PRECISION)
      .add(withdrawLevArgs.amountStableExcess)
      .add(withdrawLevArgs.amountStableWithdraw)

    console.log(
      formatEther(amountStablesFromAhlpAfter),
      formatEther(amountStablesFromAhlpBefore)
    )

    equalTol(
      amountStablesFromAhlpAfter,
      amountStablesFromAhlpBefore.mul(numer).div(denom)
    )

    expect(await cAhlp.callStatic.balanceOfUnderlying(ahlp.address)).to.equal(
      amountAhlp.sub(amountAhlpRedeem)
    )
    expect(await dai.balanceOf(owner.address)).to.equal(
      daiBalanceBefore.add(amountStableWithdraw)
    )
    if (withdrawLevArgs?.amountStableExcess.gt(0)) {
      const amountStableInLPAfter =
        await cStable.callStatic.balanceOfUnderlying(ahlp.address)
      equalTol(
        amountStableInLPAfter,
        amountStableInLPBefore.add(withdrawLevArgs.amountStableExcess)
      )
    }
  })
})
