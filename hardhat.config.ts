import "@tenderly/hardhat-tenderly"
import "hardhat-contract-sizer"

import "@nomiclabs/hardhat-waffle"
import "@typechain/hardhat"
import "hardhat-gas-reporter"
import "solidity-coverage"
import "@openzeppelin/hardhat-upgrades"
import "@nomiclabs/hardhat-etherscan"

import { resolve } from "path"

import { config as dotenvConfig } from "dotenv"
import { HardhatUserConfig, task } from "hardhat/config"

dotenvConfig({ path: resolve(__dirname, "./.env") })

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners()

  for (const account of accounts) {
    console.log(account.address)
  }
})

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200, // TODO
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        enabled: true,
        url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`,
      },
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.ALCHEMY_API_KEY}`,
      accounts: [`${process.env.DEPLOYER_PRIV}`],
    },
    local: {
      url: "http://127.0.0.1:8545",
    },
  },
  etherscan: {
    apiKey: `${process.env.ETHERSCAN_TOKEN}`,
  },
  mocha: {
    timeout: 120000,
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
}

export default config
