const fs = require('fs')
const axios = require('axios')
const {expect} = require('chai')

async function getEthPrice () {
    return Number(
        (await axios.get('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD'))['data']['USD']
    )
}

function getAddresses () {
    // noinspection JSCheckFunctionSignatures
    return JSON.parse(fs.readFileSync('addresses.json'));
}

const RES_TOL_LOWER = 9990
const RES_TOL_UPPER = 10010
const RES_TOL_TOTAL = 10000

function equalTol(a, b) {
    expect(a).gt(b.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
    expect(a).lt(b.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
}

async function revSnapshot(id) {
    await network.provider.request({
        method: 'evm_revert',
        params: [id]
    })

    return await network.provider.request({
        method: 'evm_snapshot'
    })
}

module.exports = {
    getAddresses,
    getEthPrice,
    equalTol,
    revSnapshot,
    noDeadline: Math.floor(Date.now() / 1000) * 2
}
