// noinspection JSUnresolvedFunction,JSUnresolvedVariable

const {ethers} = require('hardhat')
const {parseEther} = ethers.utils
// const {BigNumber} = require("@ethersproject.bignumber")


const {expect} = require('chai')

const {getEthPrice, getAddresses, noDeadline} = require('../scripts/utils')

const ICErc20 = require('../artifacts/interfaces/ICErc20.sol/ICErc20.json')

const WETH = require('../thirdparty/WETH.json')
const DAI = require('../thirdparty/DAI.json')
const UniswapV2Router02 = require('../thirdparty/UniswapV2Router02.json')
const FuseFeeDistributor = require('../thirdparty/FuseFeeDistributor.json')

const UNIV2_FACTORY_ADDR = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'

const MINIMUM_LIQUIDITY = 1000

const RES_TOL_LOWER = 9990
const RES_TOL_UPPER = 10010
const RES_TOL_TOTAL = 10000

describe('DeltaNeutralStableVolatilePair', function () {

    let addresses

    let ethPrice

    let owner
    let bob
    let alice

    let weth
    let dai

    let factory
    let pair

    let uniLp
    let cVol
    let cStable
    let cUniLp

    let depositedEvents = []

    const c = (artifact) => new ethers.Contract(artifact.address, artifact.abi, owner)

    let testSnapshotId

    const TEN_18 = 10**18

    before(async function () {
        [owner, bob, alice] = await ethers.getSigners()

        addresses = getAddresses()

        await network.provider.request({
            method: 'evm_revert',
            params: [addresses.snapshotId]
        })

        ethPrice = await getEthPrice()
        expect(ethPrice).to.be.greaterThan(0)

        weth = c(WETH)
        dai = c(DAI)

        const DeltaNeutralStableVolatileFactory = await ethers.getContractFactory('DeltaNeutralStableVolatileFactory')
        // const mmBps = {
        //     min: 9990,
        //     max: 10010
        // }
        factory = await DeltaNeutralStableVolatileFactory.deploy(
            weth.address,
            UNIV2_FACTORY_ADDR,
            UniswapV2Router02.address,
            addresses.unitroller,
            "0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000",
            [9900, 10100]
        )
        
        const tx = await factory.createPair(dai.address, weth.address)
        const receipt = await tx.wait()
        
        const DeltaNeutralStableVolatilePair = await ethers.getContractFactory('DeltaNeutralStableVolatilePair')
        pair = await DeltaNeutralStableVolatilePair.attach(receipt.events[4].args.pair)
        
        uniLp = new ethers.Contract(await pair.uniLp(), WETH.abi, owner)
        cVol = new ethers.Contract(await pair.cVol(), ICErc20.abi, owner)
        cStable = new ethers.Contract(await pair.cStable(), ICErc20.abi, owner)
        cUniLp = new ethers.Contract(await pair.cUniLp(), ICErc20.abi, owner)

        await weth.approve(pair.address, parseEther('100000000'))
        await weth.connect(bob).approve(pair.address, parseEther('100000000'))
        await weth.connect(alice).approve(pair.address, parseEther('100000000'))
        await dai.approve(pair.address, parseEther('100000000'))
        await dai.connect(bob).approve(pair.address, parseEther('100000000'))
        await dai.connect(alice).approve(pair.address, parseEther('100000000'))

        testSnapshotId = await network.provider.request({
            method: 'evm_snapshot'
        })
    })

    // beforeEach(async function () {
    //     await network.provider.request({
    //         method: 'evm_revert',
    //         params: [testSnapshotId]
    //     })
    // })

    it('Should deposit', async function () {

        const amountStableDesired = parseEther(String(1.1 * ethPrice)) // fuse min eth borrow amount is 1
        const amountVolDesired = parseEther('1.1')
        const amountStableMin = 0
        const amountVolMin = 0
        const swapAmountOutMin = 0

        const wethBalanceBefore = await weth.balanceOf(owner.address)

        let fuseAdminAddr = '0x5eA4A9a7592683bF0Bc187d6Da706c6c4770976F'
        fuseAdmin = await ethers.provider.getSigner(fuseAdminAddr)
        fuseFeeDistributor = new ethers.Contract(FuseFeeDistributor.address, FuseFeeDistributor.abi, fuseAdmin)

        const tx = await pair.deposit(
            amountStableDesired,
            amountVolDesired,
            [
                amountStableMin,
                amountVolMin,
                noDeadline,
                [weth.address, dai.address],
                swapAmountOutMin
            ],
            owner.address
        )
        const receipt = await tx.wait()
        const depositedEvent = receipt.events[receipt.events.length - 1]

        depositedEvents.push(depositedEvent.args)
        const {amountStableSwap, amountUniLp, amountVol} = depositedEvent.args
        const wethBalanceAfter = await weth.balanceOf(owner.address)

        expect(amountVol).to.equal(wethBalanceBefore.sub(wethBalanceAfter))
        expect(parseInt(amountStableDesired)).to.be.greaterThan(parseInt(amountStableSwap)*0.99)
        expect(parseInt(amountStableDesired)).to.be.lessThan(parseInt(amountStableSwap)*1.01)
        expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(amountVol)
        expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).to.equal(amountStableSwap)
        expect((await cUniLp.callStatic.balanceOfUnderlying(pair.address))).to.equal(amountUniLp)
    })

    // it('Should withdraw', async function () {
    //     // I'm aware this is a super noob move - just duct taping to save time
    //     await network.provider.request({
    //         method: 'evm_revert',
    //         params: [testSnapshotId]
    //     })


    //     // deposit to withdraw
    //     const amountStableDesired = parseEther(String(1.1 * ethPrice)) // fuse min eth borrow amount is 1
    //     const amountVolDesired = parseEther('1.1')
    //     let amountStableMin = 0
    //     let amountVolMin = 0
    //     let swapAmountOutMin = 0

    //     // alice
    //     const aliceStableBalanceBefore = await dai.balanceOf(alice.address)
    //     const aliceVolBalanceBefore = await weth.balanceOf(alice.address)
    //     let tx = await pair.connect(alice).deposit(
    //         amountStableDesired,
    //         amountVolDesired,
    //         [
    //             amountStableMin,
    //             amountVolMin,
    //             noDeadline,
    //             [weth.address, dai.address],
    //             swapAmountOutMin
    //         ],
    //         alice.address
    //     )
    //     let receipt = await tx.wait()

    //     const depositedEvent = receipt.events[receipt.events.length - 1]
    //     const {amountVol, amountStable, amountStableSwap, amountUniLp} = depositedEvent.args
    //     const aliceVolBalanceAfter = await weth.balanceOf(alice.address)
    //     const aliceStableBalanceAfter = await dai.balanceOf(alice.address)

    //     expect(amountVol).to.equal(aliceVolBalanceBefore.sub(aliceVolBalanceAfter))
    //     expect(parseInt(amountStableDesired)).to.be.greaterThan(parseInt(amountStableSwap)*0.99)
    //     expect(parseInt(amountStableDesired)).to.be.lessThan(parseInt(amountStableSwap)*1.01)
    //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).to.equal(amountVol)
    //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).to.equal(amountStableSwap)
    //     expect((await cUniLp.callStatic.balanceOfUnderlying(pair.address))).to.equal(amountUniLp)

    //     const aliceLiquidityBalance = await pair.balanceOf(alice.address)

    //     const liqNumer = 9999000
    //     const liqDenom = 10000000
    //     const aliceLiquidityWithdraw = aliceLiquidityBalance.mul(liqNumer).div(liqDenom)
    //     tx = await pair.connect(alice).withdraw(
    //         aliceLiquidityWithdraw,
    //         [
    //             amountStableMin,
    //             amountVolMin,
    //             noDeadline,
    //             [dai.address, weth.address],
    //             swapAmountOutMin
    //         ]
    //     )
    //     receipt = await tx.wait()
        
    //     expect(await pair.totalSupply()).to.equal(ethers.BigNumber.from(MINIMUM_LIQUIDITY).add(aliceLiquidityBalance.sub(aliceLiquidityWithdraw)))
    //     expect(await weth.balanceOf(pair.address)).to.equal(0)
    //     expect(await weth.balanceOf(factory.address)).to.equal(0)
    //     expect(await dai.balanceOf(pair.address)).to.equal(0)
    //     expect(await dai.balanceOf(factory.address)).to.equal(0)

    //     // Check the debts
    //     const totalNumerators = ethers.BigNumber.from(liqNumer).mul(997).mul(997)
    //     const totalDenominators = ethers.BigNumber.from(liqDenom).mul(1000).mul(1000)
    //     const cVolLeft = amountVol.sub(amountVol.mul(totalNumerators).div(totalDenominators))
    //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).gt(cVolLeft.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    //     expect(await cVol.callStatic.borrowBalanceCurrent(pair.address)).lt(cVolLeft.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
    //     const cStableLeft = amountStableSwap.mul(liqDenom-liqNumer).div(liqDenom)
    //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).gt(cStableLeft.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    //     expect((await cStable.callStatic.balanceOfUnderlying(pair.address))).lt(cStableLeft.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
    //     const cUniLpLeft = amountUniLp.mul(liqDenom-liqNumer).div(liqDenom)
    //     expect((await cUniLp.callStatic.balanceOfUnderlying(pair.address))).gt(cUniLpLeft.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    //     expect((await cUniLp.callStatic.balanceOfUnderlying(pair.address))).lt(cUniLpLeft.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
        
    //     // Check the user's balances
    //     const aliceWithdrawAmount = amountVol.mul(liqNumer).div(liqDenom).mul(997).mul(997).div(1000).div(1000)
    //     const aliceVolBalanceEnd = aliceVolBalanceAfter.add(aliceWithdrawAmount)
    //     expect(await weth.balanceOf(alice.address)).gt(aliceVolBalanceEnd.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    //     expect(await weth.balanceOf(alice.address)).lt(aliceVolBalanceEnd.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
    //     const aliceStableBalanceEnd = aliceStableBalanceAfter.add(amountStable.mul(liqNumer).div(liqDenom))
    //     expect(await dai.balanceOf(alice.address)).gt(aliceStableBalanceEnd.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    //     expect(await dai.balanceOf(alice.address)).lt(aliceStableBalanceEnd.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
    // })
})
