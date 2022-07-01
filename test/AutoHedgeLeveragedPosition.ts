import { ethers } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, constants, ContractReceipt, utils } from "ethers"

import {
  FusePoolLens,
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
  FlashloanWrapperProxy,
  AutoHedgeLeveragedPosition,
  BeaconProxy,
} from "typechain"

import {
  getAddresses,
  UnitrollerSnapshot,
  ArtifactType,
  snapshot,
  revertSnapshot,
  noDeadline,
  defaultDepositEvent,
  JUMP_RATE_MODEL_UNI_ADDR,
  CERC20_IMPLEMENTATION_ADDR,
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

describe.only("AutoHedgeLeveragedPosition", () => {
  let addresses: UnitrollerSnapshot

  let owner: SignerWithAddress
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

  let admin: TProxyAdmin
  let factoryProxy: TProxy
  let beacon: UBeacon
  let pairImpl: DeltaNeutralStableVolatilePairUpgradeable
  let comptroller: string
  let levTokens

  let registry: Registry

  let testSnapshotId: string

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

    admin = <TProxyAdmin>await TProxyAdminFactory.deploy()
    pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
      await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
    )
    beacon = <UBeacon>await UBeaconFactory.deploy(pairImpl.address)
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
    const unitroller = <Unitroller>(
      new ethers.Contract(comptroller, UnitrollerAbi.abi, owner)
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

    masterPriceOracle = <MasterPriceOracle>(
      new ethers.Contract(addresses.oracle, MasterPriceOracleAbi.abi, owner)
    )
    // TODO make a separate Price Oracle for AHLP
    const ahOracle = await (
      await ethers.getContractFactory("AutoHedgeOracle")
    ).deploy(weth.address)
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

    try {
      await unitroller._deployMarket(
        false,
        ethers.utils.defaultAbiCoder.encode(constructorTypes, [
          pair.address,
          unitroller.address,
          JUMP_RATE_MODEL_UNI_ADDR,
          "DAI ETH AHLP",
          "fAH-DAI-ETH-185",
          CERC20_IMPLEMENTATION_ADDR,
          0x00,
          reserveFactor,
          0,
        ]),
        collateralFactorMantissa
      )
    } catch (err) {
      console.log(err)
    }

    const fuseLens = <FusePoolLens>c(FusePoolLensAbi)
    // console.log(await unitroller.getAllMarkets())
    try {
      // const assets = await fuseLens.callStatic.getPoolAssetsWithData(
      //   unitroller.address
      // )
      // console.log(assets)
      console.log(await fuseLens.callStatic.getPoolSummary(unitroller.address))
    } catch (err) {
      console.log(err)
    }

    await weth.approve(pair.address, constants.MaxUint256)
    await dai.approve(pair.address, constants.MaxUint256)
  }

  async function deployFlashLoanWrapper() {
    const FlashloanWrapperFactory = await ethers.getContractFactory(
      "FlashloanWrapper"
    )
    const flwImpl = <FlashloanWrapper>await FlashloanWrapperFactory.deploy()
    const FlashloanWrapperProxyFactory = await ethers.getContractFactory(
      "FlashloanWrapperProxy"
    )
    const flwProxy = <FlashloanWrapperProxy>(
      await FlashloanWrapperProxyFactory.deploy(
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
    const AutoHedgeLeveragedPositionFactory = await ethers.getContractFactory(
      "AutoHedgeLeveragedPosition"
    )
    const ahlpImpl = <AutoHedgeLeveragedPosition>(
      await AutoHedgeLeveragedPositionFactory.deploy()
    )
    const UBeaconFactory = await ethers.getContractFactory("UBeacon")
    const beacon = <UBeacon>await UBeaconFactory.deploy(ahlpImpl.address)
    const BeaconProxyFactory = await ethers.getContractFactory("BeaconProxy")
    const ahlpProxy = <BeaconProxy>(
      await BeaconProxyFactory.deploy(
        beacon.address,
        ahlpImpl.interface.encodeFunctionData("initialize", [flw.address])
      )
    )
    ahlp = <AutoHedgeLeveragedPosition>(
      await AutoHedgeLeveragedPositionFactory.attach(ahlpProxy.address)
    )

    expect(await ahlp.flw()).to.equal(flw.address)
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
    const depositedEvent = receipt.events?.find(
      ({ event }) => event === "Deposited"
    )
    return depositedEvent?.args ?? defaultDepositEvent
  }

  beforeEach(async () => {
    testSnapshotId = await snapshot()
  })

  afterEach(async () => {
    await revertSnapshot(testSnapshotId)
  })

  before(async () => {
    ;[owner, feeReceiver] = await ethers.getSigners()

    await deployAutoHedge()
    await deployFlashLoanWrapper()
    await deployAutoHedgeLeveragedPosition()
  })

  describe("depositLev", () => {
    it("should work as expected", async () => {
      const wethPrice = await getWETHPrice()
      const amountStableDeposit = parseEther(String(1.1 * wethPrice * 2))
      const amountVolZapMin = parseEther("1")
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
      const {
        amountsStableToVol,
        amountVolEstimated,
        amountStableEstimated,
        amountStableSwappedIntoEstimated,
      } = await estimateDeposit(amountToDepositToAH)

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

      const { amountStable, amountUniLp, amountVol } = getDepositEvent(receipt)

      console.log(parseEther(amountStable), parseEther(amountVol))
    })
  })
})
