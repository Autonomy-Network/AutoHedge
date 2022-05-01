const hre = require('hardhat')
const fs = require('fs');

const {ethers} = require('hardhat')
const {expect} = require('chai')

const {Interface, parseEther} = ethers.utils

const {getEthPrice} = require('./utils');

const WETH = require('../thirdparty/WETH.json')
const DAI = require('../thirdparty/DAI.json')

const UniswapV2Router02 = require('../thirdparty/UniswapV2Router02.json')

const InitializableClones = require('../thirdparty/InitializableClones.json')
const MasterPriceOracle = require('../thirdparty/MasterPriceOracle.json')
const FusePoolDirectory = require('../thirdparty/FusePoolDirectory.json')
const FusePoolLens = require('../thirdparty/FusePoolLens.json')
const Unitroller = require('../thirdparty/Unitroller.json')
const FuseFeeDistributor = require('../thirdparty/FuseFeeDistributor.json')

const ICErc20 = require('../artifacts/interfaces/ICErc20.sol/ICErc20.json')

const UNIV2_DAI_ETH_LP_ADDR = '0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11'

const FUSE_DEFAULT_ORACLE_ADDR = '0x1887118E49e0F4A78Bd71B792a49dE03504A764D'
const COMPTROLLER_IMPL_ADDR = '0xe16db319d9da7ce40b666dd2e365a4b8b3c18217'
const JUMP_RATE_MODEL_ADDR = '0xbAB47e4B692195BF064923178A90Ef999A15f819'
const JUMP_RATE_MODEL_UNI_ADDR = '0xc35DB333EF7ce4F246DE9DE11Cc1929d6AA11672' // noinspection SpellCheckingInspection
const CERC20_IMPLEMENTATION_ADDR = '0x67Db14E73C2Dce786B5bbBfa4D010dEab4BBFCF9'

let ethPrice

let owner
let bob
let alice

let weth
let dai

let uniRouter

let fuseClones
let masterPriceOracle = new Interface(MasterPriceOracle.abi)
let fuse
let fuseLens

let unitroller

let uniLp
let cVol
let cStable
let cUniLp

const c = (artifact) => new ethers.Contract(artifact.address, artifact.abi, owner)

async function deployMasterPriceOracle() {
    const initializerData = masterPriceOracle.encodeFunctionData('initialize', [
        [],
        [],
        FUSE_DEFAULT_ORACLE_ADDR,
        owner.address,
        true
    ])
    const tx = await fuseClones.clone(MasterPriceOracle.address, initializerData)
    const receipt = await tx.wait()
    masterPriceOracle = new ethers.Contract(receipt.events[0].args.instance, MasterPriceOracle.abi, owner)
}

async function deployPool() {
    const closeFactor = ethers.BigNumber.from('500000000000000000')
    const liquidationIncentive = ethers.BigNumber.from('1080000000000000000')
    await fuse.deployPool(
        'Test0',
        COMPTROLLER_IMPL_ADDR,
        false,
        closeFactor,
        liquidationIncentive,
        masterPriceOracle.address
    )
    const pools = await fuse.getPoolsByAccount(owner.address)

    unitroller = new ethers.Contract(pools[1][0][2], Unitroller.abi, owner)
    await unitroller._acceptAdmin()
}

async function deployMarkets() {
    const reserveFactor = ethers.BigNumber.from('100000000000000000')
    const collateralFactorMantissa = ethers.BigNumber.from('700000000000000000')
    const constructorTypes = [
        'address',
        'address',
        'address',
        'string',
        'string',
        'address',
        'bytes',
        'uint256',
        'uint256',
    ]
    const oracle = await (await ethers.getContractFactory('Oracle')).deploy() // TODO
    await masterPriceOracle.add([UNIV2_DAI_ETH_LP_ADDR], [oracle.address])
    await unitroller._deployMarket(
        false,
        ethers.utils.defaultAbiCoder.encode(constructorTypes, [
            UNIV2_DAI_ETH_LP_ADDR,
            unitroller.address,
            JUMP_RATE_MODEL_UNI_ADDR,
            'UniV2 DAI ETH LP', // TODO
            'fUNI-DAI-ETH-185', // TODO pool id
            CERC20_IMPLEMENTATION_ADDR,
            0x00,
            reserveFactor,
            0
        ]),
        collateralFactorMantissa
    )
    await unitroller._deployMarket(
        false,
        ethers.utils.defaultAbiCoder.encode(constructorTypes, [
            dai.address,
            unitroller.address,
            JUMP_RATE_MODEL_ADDR,
            'Test0 DAI', // TODO
            'fDAI-185', // TODO pool id
            CERC20_IMPLEMENTATION_ADDR,
            0x00,
            reserveFactor,
            0
        ]),
        collateralFactorMantissa
    )
    await unitroller._deployMarket(
        false,
        ethers.utils.defaultAbiCoder.encode(constructorTypes, [
            weth.address,
            unitroller.address,
            JUMP_RATE_MODEL_ADDR,
            'Test0 Ethereum', // TODO
            'fETH-185', // TODO pool id
            CERC20_IMPLEMENTATION_ADDR,
            0x00,
            reserveFactor,
            0
        ]),
        collateralFactorMantissa
    )
    
    const assets = await fuseLens.getPoolAssetsWithData(unitroller.address)
    expect(assets[0]['underlyingSymbol']).to.equal('DAI-WETH')
    expect(assets[1]['underlyingSymbol']).to.equal('DAI')
    expect(assets[2]['underlyingSymbol']).to.equal('WETH')
}

async function setupFunds() {
    // get weth
    let amount = parseEther('2000')
    await weth.deposit({value: amount})
    await weth.connect(bob).deposit({value: amount})
    await weth.connect(alice).deposit({value: amount})
    expect(await weth.balanceOf(owner.address)).to.equal(amount)
    expect(await weth.balanceOf(bob.address)).to.equal(amount)
    expect(await weth.balanceOf(alice.address)).to.equal(amount)

    // get dai
    amount = parseEther('1000000')
    let daiWhale = '0xe78388b4ce79068e89bf8aa7f218ef6b9ab0e9d0'
    await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [daiWhale],
    })
    daiWhale = await ethers.provider.getSigner(daiWhale)
    await dai.connect(daiWhale).transfer(owner.address, amount)
    await dai.connect(daiWhale).transfer(bob.address, amount)
    await dai.connect(daiWhale).transfer(alice.address, amount)
    expect(await dai.balanceOf(owner.address)).to.equal(amount)
    expect(await dai.balanceOf(bob.address)).to.equal(amount)
    expect(await dai.balanceOf(alice.address)).to.equal(amount)
    
    // deposit volatile to fuse
    amount = parseEther('1000')
    await weth.approve(cVol.address, amount)
    await cVol.mint(amount)
    expect(await cVol.callStatic.balanceOfUnderlying(owner.address)).to.equal(amount)
}

async function main() {
    [owner, bob, alice] = await ethers.getSigners()
    
    let fuseAdminAddr = '0x5eA4A9a7592683bF0Bc187d6Da706c6c4770976F'
    await owner.sendTransaction({
        to: fuseAdminAddr,
        value: parseEther("1"),
    })
    await hre.network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [fuseAdminAddr],
    })
    fuseAdmin = await ethers.provider.getSigner(fuseAdminAddr)
    fuseFeeDistributor = new ethers.Contract(FuseFeeDistributor.address, FuseFeeDistributor.abi, fuseAdmin)
    await fuseFeeDistributor._setPoolLimits(parseEther('1'), ethers.BigNumber.from("115792089237316195423570985008687907853269984665640564039457584007913129639935"), 1)

    ethPrice = await getEthPrice()
    expect(ethPrice).to.be.greaterThan(0)
    
    weth = c(WETH)
    dai = c(DAI)
    
    uniRouter = c(UniswapV2Router02)
    
    fuseClones = c(InitializableClones)
    fuse = c(FusePoolDirectory)
    fuseLens = c(FusePoolLens)
    
    await deployMasterPriceOracle()
    await deployPool()
    await deployMarkets()
    
    uniLp = new ethers.Contract(UNIV2_DAI_ETH_LP_ADDR, WETH.abi, owner)
    cVol = new ethers.Contract(await unitroller.cTokensByUnderlying(weth.address), ICErc20.abi, owner)
    cStable = new ethers.Contract(await unitroller.cTokensByUnderlying(dai.address), ICErc20.abi, owner)
    cUniLp = new ethers.Contract(await unitroller.cTokensByUnderlying(uniLp.address), ICErc20.abi, owner)
    
    await unitroller.enterMarkets([
        cStable.address,
        cVol.address,
        cUniLp.address
    ])
    
    await setupFunds()
    
    const snapshotId = await network.provider.request({
        method: 'evm_snapshot'
    })
    
    const addresses = {
        snapshotId,
        unitroller: unitroller.address,
    }
    fs.writeFileSync('addresses.json', JSON.stringify(addresses))
    
    console.log('addresses', addresses)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
