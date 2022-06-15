// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
// noinspection JSUnresolvedFunction,JSUnresolvedVariable

import hre, { ethers } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { getEthPrice, getAddresses } from "./utils"
import WETH from "thirdparty/WETH.json"
import DAI from "thirdparty/DAI.json"
import UniswapV2Router02 from "thirdparty/UniswapV2Router02.json"
import {
  DeltaNeutralStableVolatileFactoryUpgradeable,
  DeltaNeutralStableVolatilePairUpgradeable,
  ICErc20,
  IERC20,
  MockSqrt,
  UBeacon,
  Registry,
  TProxyAdmin,
  TProxy,
} from "typechain"

const { Interface, parseEther } = ethers.utils

const addresses = getAddresses()

// // BSC Testnet
// const UNIV2_FACTORY_ADDR = '0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc'
// const UNIV2_ROUTER_ADDR = '0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3'
// const UNITROLLER_ADDR = '0x25276cbE1eF2eeb838aBa236150FD3573064767e'
// const WETH_ADDR = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
// const STABLE_ADDR = '0x8a9424745056Eb399FD19a0EC26A14316684e274';

// BSC Mainnet
// const UNIV2_FACTORY_ADDR = "0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc"
// const UNIV2_ROUTER_ADDR = "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3"
// const UNITROLLER_ADDR = "0x25276cbE1eF2eeb838aBa236150FD3573064767e"
// const WETH_ADDR = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
// const STABLE_ADDR = "0x8a9424745056Eb399FD19a0EC26A14316684e274"
// const REG_ADDR = "0x18d087F8D22D409D3CD366AF00BD7AeF0BF225Db"
// const UFF_ADDR = "0x4F54277e6412504EBa0B259A9E4c69Dc7EE4bB9c"

// ETH Mainnet Fork
const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
const UNIV2_ROUTER_ADDR = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
const UNITROLLER_ADDR = addresses.unitroller
const WETH_ADDR = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const STABLE_ADDR = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const REG_ADDR = addresses.reg
const UFF_ADDR = addresses.uff

let owner

let admin: TProxyAdmin
let factoryProxy: TProxy
let beacon: UBeacon
let pairImpl: DeltaNeutralStableVolatilePairUpgradeable
let factory: DeltaNeutralStableVolatileFactoryUpgradeable

async function main() {
  ;[owner] = await ethers.getSigners()

  // const TProxyAdminFactory = await ethers.getContractFactory("TProxyAdmin")
  // const DeltaNeutralStableVolatilePairUpgradeable =
  //   await ethers.getContractFactory("DeltaNeutralStableVolatilePairUpgradeable")
  // const DeltaNeutralStableVolatileFactory = await ethers.getContractFactory(
  //   "DeltaNeutralStableVolatileFactory"
  // )

  // const admin = await TProxyAdminFactory.deploy()
  // const pairImpl = await DeltaNeutralStableVolatilePairUpgradeable.deploy()
  // const factory = await DeltaNeutralStableVolatileFactory.deploy(
  //   pairImpl.address,
  //   admin.address,
  //   WETH_ADDR,
  //   UNIV2_FACTORY_ADDR,
  //   UNIV2_ROUTER_ADDR,
  //   addresses.unitroller,
  //   REG_ADDR,
  //   UFF_ADDR,
  //   [9900, 10100]
  // )

  // const tx = await factory.createPair(STABLE_ADDR, WETH_ADDR)
  // const receipt = await tx.wait()
  // console.log(receipt.events)

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
  admin = <TProxyAdmin>await TProxyAdminFactory.deploy()
  pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
    await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
  )
  console.log("DeltaNeutralStableVolatilePairUpgradeable implementation: ", pairImpl.address)
  beacon = <UBeacon>await UBeaconFactory.deploy(pairImpl.address)
  console.log("UpgradeableBeacon: ", beacon.address)
  const factoryImpl = <DeltaNeutralStableVolatileFactoryUpgradeable>(
    await DeltaNeutralStableVolatileFactoryUpgradeableFactory.deploy()
  )
  factoryProxy = <TProxy>await TProxyFactory.deploy(
    factoryImpl.address,
    admin.address,
    factoryImpl.interface.encodeFunctionData(
      "initialize",
      [
        beacon.address,
        WETH_ADDR,
        UNIV2_FACTORY_ADDR,
        UNIV2_ROUTER_ADDR,
        UNITROLLER_ADDR,
        REG_ADDR,
        UFF_ADDR,
        {
          min: parseEther("0.99"),
          max: parseEther("1.01"),
        },
        owner.address,
      ],
    )
  )
  factory = <DeltaNeutralStableVolatileFactoryUpgradeable>(
    await DeltaNeutralStableVolatileFactoryUpgradeableFactory.attach(factoryProxy.address)
  )
  console.log("DeltaNeutralStableVolatileFactoryUpgradeable implementation: ", factory.address)

  const tx = await factory.createPair(STABLE_ADDR, WETH_ADDR)
  const receipt = await tx.wait()
  const lastEvent = receipt.events?.pop()
  const pairAddress = lastEvent ? lastEvent.args?.pair : ""
  console.log('Pair: ', pairAddress)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
