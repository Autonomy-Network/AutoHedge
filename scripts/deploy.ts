// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
// noinspection JSUnresolvedFunction,JSUnresolvedVariable

import hre, { ethers } from "hardhat"
import fs from "fs"
import { expect } from "chai"
import { getEthPrice } from "./utils"
import WETH from "thirdparty/WETH.json"
import DAI from "thirdparty/DAI.json"
import UniswapV2Router02 from "thirdparty/UniswapV2Router02.json"

const { Interface, parseEther } = ethers.utils

// // BSC Testnet
// const UNIV2_FACTORY_ADDR = '0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc'
// const UNIV2_ROUTER_ADDR = '0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3'
// const UNITROLLER_ADDR = '0x25276cbE1eF2eeb838aBa236150FD3573064767e'
// const WETH_ADDR = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
// const DAI_ADDR = '0x8a9424745056Eb399FD19a0EC26A14316684e274';

// BSC Mainnet
const UNIV2_FACTORY_ADDR = "0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc"
const UNIV2_ROUTER_ADDR = "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3"
const UNITROLLER_ADDR = "0x25276cbE1eF2eeb838aBa236150FD3573064767e"
const WETH_ADDR = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd"
const DAI_ADDR = "0x8a9424745056Eb399FD19a0EC26A14316684e274"
const REG_ADDR = "0x18d087F8D22D409D3CD366AF00BD7AeF0BF225Db"
const UFF_ADDR = "0x4F54277e6412504EBa0B259A9E4c69Dc7EE4bB9c"

let owner

async function main() {
  ;[owner] = await ethers.getSigners()

  const TProxyAdminFactory = await ethers.getContractFactory()

  admin = await TProxyAdmin.deploy()
  pairImpl = await DeltaNeutralStableVolatilePairUpgradeable.deploy()
  factory = await DeltaNeutralStableVolatileFactory.deploy(
    pairImpl.address,
    admin.address,
    WETH_ADDR,
    UNIV2_FACTORY_ADDR,
    UNIV2_ROUTER_ADDR,
    addresses.unitroller,
    REG_ADDR,
    UFF_ADDR,
    [9900, 10100]
  )

  const tx = await factory.createPair(DAI_ADDR, WETH_ADDR)
  console.log(receipt.events)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
