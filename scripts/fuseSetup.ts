import hre, { artifacts, ethers } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ICErc20, IERC20 } from "typechain"
import type {
  FusePoolDirectory,
  WETH,
  Unitroller,
  FusePoolLens,
  MasterPriceOracle,
  InitializableClones,
} from "typechain/thirdparty"
import {
  ArtifactType,
  getEthPrice,
  snapshot,
  JUMP_RATE_MODEL_ADDR,
  JUMP_RATE_MODEL_UNI_ADDR,
  CERC20_IMPLEMENTATION_ADDR,
} from "./utils"

import WETHAbi from "../thirdparty/WETH.json"
import DAI from "../thirdparty/DAI.json"
import UniswapV2Router02 from "../thirdparty/UniswapV2Router02.json"
import InitializableClonesAbi from "../thirdparty/InitializableClones.json"
import MasterPriceOracleAbi from "../thirdparty/MasterPriceOracle.json"
import FusePoolDirectoryAbi from "../thirdparty/FusePoolDirectory.json"
import FusePoolLensAbi from "../thirdparty/FusePoolLens.json"
import UnitrollerAbi from "../thirdparty/Unitroller.json"
import FuseFeeDistributor from "../thirdparty/FuseFeeDistributor.json"

import ICErc20Abi from "../artifacts/interfaces/ICErc20.sol/ICErc20.json"
import { formatEther } from "ethers/lib/utils"

const { Interface, parseEther } = ethers.utils

const UNIV2_DAI_ETH_ADDR = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11"

const FUSE_DEFAULT_ORACLE_ADDR = "0x1887118E49e0F4A78Bd71B792a49dE03504A764D"
const COMPTROLLER_IMPL_ADDR = "0xe16db319d9da7ce40b666dd2e365a4b8b3c18217"
const DAI_WHALE_ADDR = "0xe78388b4ce79068e89bf8aa7f218ef6b9ab0e9d0"

let ethPrice

let owner: SignerWithAddress
let bob: SignerWithAddress
let alice: SignerWithAddress
let priceCoordinator: SignerWithAddress

let weth: WETH
let dai: IERC20

let uniRouter

let fuseClones: InitializableClones
let masterPriceOracle: MasterPriceOracle
let fuse: FusePoolDirectory
let fuseLens: FusePoolLens

let unitroller: Unitroller

let uniLp
let cVol: ICErc20
let cStable
let cUniLp

let reg

const c = (artifact: ArtifactType) =>
  new ethers.Contract(artifact.address, artifact.abi, owner)

async function deployMasterPriceOracle() {
  const initializerData = new Interface(
    MasterPriceOracleAbi.abi
  ).encodeFunctionData("initialize", [
    [],
    [],
    FUSE_DEFAULT_ORACLE_ADDR,
    owner.address,
    true,
  ])
  const tx = await fuseClones.clone(
    MasterPriceOracleAbi.address,
    initializerData
  )
  const receipt = await tx.wait()

  const instance = receipt.events?.length
    ? receipt.events[0].args?.instance
    : ""

  masterPriceOracle = <MasterPriceOracle>(
    new ethers.Contract(instance, MasterPriceOracleAbi.abi, owner)
  )
}

async function deployPool() {
  const closeFactor = ethers.BigNumber.from("500000000000000000")
  const liquidationIncentive = ethers.BigNumber.from("1080000000000000000")
  await fuse.deployPool(
    "Test0",
    COMPTROLLER_IMPL_ADDR,
    false,
    closeFactor,
    liquidationIncentive,
    masterPriceOracle.address
  )
  const pools = await fuse.getPoolsByAccount(owner.address)

  unitroller = <Unitroller>(
    new ethers.Contract(pools[1][0][2], UnitrollerAbi.abi, owner)
  )
  await unitroller._acceptAdmin()
}

async function deployMarkets() {
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
  const fuseOracle = await (
    await ethers.getContractFactory("FuseOracle")
  ).deploy()
  await masterPriceOracle.add(
    [UNIV2_DAI_ETH_ADDR],
    ["0x50F42c004Bd9B0E5ACc65c33Da133FBFbE86c7C0"]
  )
  await unitroller._deployMarket(
    false,
    ethers.utils.defaultAbiCoder.encode(constructorTypes, [
      UNIV2_DAI_ETH_ADDR,
      unitroller.address,
      JUMP_RATE_MODEL_UNI_ADDR,
      "UniV2 DAI ETH LP",
      "fUNI-DAI-ETH-185",
      CERC20_IMPLEMENTATION_ADDR,
      0x00,
      reserveFactor,
      0,
    ]),
    collateralFactorMantissa
  )
  await unitroller._deployMarket(
    false,
    ethers.utils.defaultAbiCoder.encode(constructorTypes, [
      dai.address,
      unitroller.address,
      JUMP_RATE_MODEL_ADDR,
      "Test0 DAI",
      "fDAI-185",
      CERC20_IMPLEMENTATION_ADDR,
      0x00,
      reserveFactor,
      0,
    ]),
    collateralFactorMantissa
  )
  await unitroller._deployMarket(
    false,
    ethers.utils.defaultAbiCoder.encode(constructorTypes, [
      weth.address,
      unitroller.address,
      JUMP_RATE_MODEL_ADDR,
      "Test0 WETH",
      "fETH-185",
      CERC20_IMPLEMENTATION_ADDR,
      0x00,
      reserveFactor,
      0,
    ]),
    collateralFactorMantissa
  )

  const assets = await fuseLens.callStatic.getPoolAssetsWithData(
    unitroller.address
  )
  expect(assets[0]["underlyingSymbol"]).to.equal("DAI-WETH")
  expect(assets[1]["underlyingSymbol"]).to.equal("DAI")
  expect(assets[2]["underlyingSymbol"]).to.equal("WETH")
}

async function setupFunds() {
  // get weth
  let amount = parseEther("2000")
  await weth.deposit({ value: amount })
  await weth.connect(alice).deposit({ value: amount })
  await weth.connect(bob).deposit({ value: amount })
  await weth.connect(priceCoordinator).deposit({ value: amount })
  expect(await weth.balanceOf(owner.address)).to.equal(amount)
  expect(await weth.balanceOf(alice.address)).to.equal(amount)
  expect(await weth.balanceOf(bob.address)).to.equal(amount)
  expect(await weth.balanceOf(priceCoordinator.address)).to.equal(amount)

  // get dai
  amount = parseEther("1000000")
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DAI_WHALE_ADDR],
  })
  const daiWhale = await ethers.provider.getSigner(DAI_WHALE_ADDR)
  await dai.transfer(
    ethers.constants.AddressZero,
    await dai.balanceOf(owner.address)
  )
  await dai.connect(daiWhale).transfer(owner.address, amount)
  await dai.connect(daiWhale).transfer(alice.address, amount)
  await dai.connect(daiWhale).transfer(bob.address, amount)
  await dai.connect(daiWhale).transfer(priceCoordinator.address, amount)
  expect(await dai.balanceOf(owner.address)).to.equal(amount)
  expect(await dai.balanceOf(alice.address)).to.equal(amount)
  expect(await dai.balanceOf(bob.address)).to.equal(amount)
  expect(await dai.balanceOf(priceCoordinator.address)).to.equal(amount)

  // deposit volatile to fuse
  amount = parseEther("1000")
  await weth.approve(cVol.address, amount)
  await cVol.mint(amount)
  expect(await cVol.callStatic.balanceOfUnderlying(owner.address)).to.equal(
    amount
  )
}

async function deployAutonomy() {
  const po = await (
    await ethers.getContractFactoryFromArtifact(
      await artifacts.readArtifact(
        "contracts/autonomy/PriceOracle.sol:PriceOracle"
      )
    )
  ).deploy(parseEther("2000"), ethers.BigNumber.from(5000000000))
  const o = await (
    await ethers.getContractFactory("Oracle")
  ).deploy(po.address, false)
  const sm = await (
    await ethers.getContractFactory("StakeManager")
  ).deploy(o.address)
  const uf = await (await ethers.getContractFactory("Forwarder")).deploy()
  const ff = await (await ethers.getContractFactory("Forwarder")).deploy()
  const uff = await (await ethers.getContractFactory("Forwarder")).deploy()
  const reg = await (
    await ethers.getContractFactory("Registry")
  ).deploy(
    sm.address,
    o.address,
    uf.address,
    ff.address,
    uff.address,
    "Autonomy Network",
    "AUTO",
    parseEther("1000000000")
  )

  await sm.setAUTO(await reg.getAUTOAddr())
  await uf.setCaller(reg.address, true)
  await ff.setCaller(reg.address, true)
  await uff.setCaller(reg.address, true)

  return [reg, uff]
}

async function main() {
  ;[owner, bob, alice, priceCoordinator] = await ethers.getSigners()

  let fuseAdminAddr = "0x5eA4A9a7592683bF0Bc187d6Da706c6c4770976F"
  await owner.sendTransaction({
    to: fuseAdminAddr,
    value: parseEther("1"),
  })
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [fuseAdminAddr],
  })
  const fuseAdmin = await ethers.provider.getSigner(fuseAdminAddr)
  const fuseFeeDistributor = new ethers.Contract(
    FuseFeeDistributor.address,
    FuseFeeDistributor.abi,
    fuseAdmin
  )
  await fuseFeeDistributor._setPoolLimits(
    parseEther("1"),
    ethers.BigNumber.from(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    ),
    1
  )

  ethPrice = await getEthPrice()
  expect(ethPrice).to.be.greaterThan(0)

  weth = <WETH>c(WETHAbi)
  dai = <IERC20>c(DAI)

  uniRouter = c(UniswapV2Router02)

  fuseClones = <InitializableClones>c(InitializableClonesAbi)
  fuse = <FusePoolDirectory>c(FusePoolDirectoryAbi)
  fuseLens = <FusePoolLens>c(FusePoolLensAbi)
  await deployMasterPriceOracle()
  await deployPool()
  await deployMarkets()

  uniLp = new ethers.Contract(UNIV2_DAI_ETH_ADDR, WETHAbi.abi, owner)
  cVol = <ICErc20>(
    new ethers.Contract(
      await unitroller.cTokensByUnderlying(weth.address),
      ICErc20Abi.abi,
      owner
    )
  )
  cStable = new ethers.Contract(
    await unitroller.cTokensByUnderlying(dai.address),
    ICErc20Abi.abi,
    owner
  )
  cUniLp = new ethers.Contract(
    await unitroller.cTokensByUnderlying(uniLp.address),
    ICErc20Abi.abi,
    owner
  )

  await unitroller.enterMarkets([cStable.address, cVol.address, cUniLp.address])

  await setupFunds()

  const daiWhale = await ethers.provider.getSigner(DAI_WHALE_ADDR)
  await dai.connect(daiWhale).transfer(cStable.address, parseEther("1000000"))

  const [reg, uff] = await deployAutonomy()

  const snapshotId = await snapshot()

  const addresses = {
    snapshotId,
    unitroller: unitroller.address,
    reg: reg.address,
    uff: uff.address,
    oracle: masterPriceOracle.address,
  }
  fs.writeFileSync("addresses.json", JSON.stringify(addresses))

  console.log("addresses", addresses)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
