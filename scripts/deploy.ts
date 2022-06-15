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
// const REG_ADDR = "0x2d08DAAE7687f4516287EBF1bF6c3819f7517Ac9"
// const UFF_ADDR = "0x804dEA3Bda49E7D05dde2ebb52797aB41b730c26"

// BSC Mainnet
const UNIV2_FACTORY_ADDR = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"
const UNIV2_ROUTER_ADDR = "0x10ED43C718714eb63d5aA57B78B54704E256024E"
const UNITROLLER_ADDR = "0xEF0B026F93ba744cA3EDf799574538484c2C4f80"
const WETH_ADDR = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
const STABLE_ADDR = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"
const REG_ADDR = "0x18d087F8D22D409D3CD366AF00BD7AeF0BF225Db"
const UFF_ADDR = "0x4F54277e6412504EBa0B259A9E4c69Dc7EE4bB9c"

// ETH Mainnet Fork
// const UNIV2_FACTORY_ADDR = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
// const UNIV2_ROUTER_ADDR = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
// const UNITROLLER_ADDR = addresses.unitroller
// const WETH_ADDR = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
// const STABLE_ADDR = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
// const REG_ADDR = addresses.reg
// const UFF_ADDR = addresses.uff

let owner

let admin: TProxyAdmin
let factoryProxy: TProxy
let beacon: UBeacon
let pairImpl: DeltaNeutralStableVolatilePairUpgradeable
let factory: DeltaNeutralStableVolatileFactoryUpgradeable

let receipt

async function main() {
  ;[owner] = await ethers.getSigners()

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
  console.log("Admin:", admin.address)
  await admin.deployTransaction.wait(1)
  pairImpl = <DeltaNeutralStableVolatilePairUpgradeable>(
    await DeltaNeutralStableVolatilePairUpgradeableFactory.deploy()
  )
  console.log("DeltaNeutralStableVolatilePairUpgradeable implementation:", pairImpl.address)
  await pairImpl.deployTransaction.wait(1)
  beacon = <UBeacon>await UBeaconFactory.deploy(pairImpl.address)
  console.log("UpgradeableBeacon:", beacon.address)
  await beacon.deployTransaction.wait(1)
  const factoryImpl = <DeltaNeutralStableVolatileFactoryUpgradeable>(
    await DeltaNeutralStableVolatileFactoryUpgradeableFactory.deploy()
  )
  console.log("DeltaNeutralStableVolatileFactoryUpgradeable implementation:", factoryImpl.address)
  await factoryImpl.deployTransaction.wait(1)

  console.log('data =', factoryImpl.interface.encodeFunctionData(
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
  ))

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
  console.log("DeltaNeutralStableVolatileFactoryUpgradeable proxy:", factoryProxy.address)
  await factoryProxy.deployTransaction.wait(1)
  // factoryProxy = <TProxy>await TProxyFactory.attach('0x951cf7124450AB10A83465aA9cE1759ceeF69aC0')
  factory = <DeltaNeutralStableVolatileFactoryUpgradeable>(
    await DeltaNeutralStableVolatileFactoryUpgradeableFactory.attach(factoryProxy.address)
  )

  const tx = await factory.createPair(STABLE_ADDR, WETH_ADDR)
  receipt = await tx.wait()
  const lastEvent = receipt.events?.pop()
  const pairAddress = lastEvent ? lastEvent.args?.pair : ""
  console.log('Pair:', pairAddress)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
