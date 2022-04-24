// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
// noinspection JSUnresolvedFunction,JSUnresolvedVariable

const hre = require('hardhat')
const fs = require('fs');

const {ethers} = require('hardhat')
const {expect} = require('chai')

const {Interface, parseEther} = ethers.utils

const {getEthPrice} = require('./utils');

const WETH = require('../thirdparty/WETH.json')
const DAI = require('../thirdparty/DAI.json')

const UniswapV2Router02 = require('../thirdparty/UniswapV2Router02.json')

const UNIV2_FACTORY_ADDR = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
const UNITROLLER_ADDR = '0x25276cbE1eF2eeb838aBa236150FD3573064767e'

let owner
let bob
let alice

let weth
let dai

const c = (artifact) => new ethers.Contract(artifact.address, artifact.abi, owner)

async function main() {
    [owner] = await ethers.getSigners()

    weth = c(WETH)
    dai = c(DAI)

    const DeltaNeutralStableVolatileFactory = await ethers.getContractFactory('DeltaNeutralStableVolatileFactory')
    factory = await DeltaNeutralStableVolatileFactory.deploy(
        weth.address,
        UNIV2_FACTORY_ADDR,
        UniswapV2Router02.address,
        UNITROLLER_ADDR,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000"
    )

    const tx = await factory.createPair(weth.address, dai.address, 9900, 10100)
    const receipt = await tx.wait()
    console.log(receipt.events)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
