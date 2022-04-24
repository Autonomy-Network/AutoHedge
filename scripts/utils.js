const fs = require('fs')
const axios = require('axios')

async function getEthPrice () {
    return Number(
        (await axios.get('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD'))['data']['USD']
    )
}

function getAddresses () {
    // noinspection JSCheckFunctionSignatures
    return JSON.parse(fs.readFileSync('addresses.json'));
}

module.exports = {
    getAddresses,
    getEthPrice,
    noDeadline: Math.floor(Date.now() / 1000) * 2
}
