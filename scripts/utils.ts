import fs from "fs"
import axios from "axios"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { network } from "hardhat"

export function getAddresses() {
  // noinspection JSCheckFunctionSignatures
  return JSON.parse(fs.readFileSync("addresses.json").toString())
}

export async function getEthPrice() {
  return Number(
    (
      await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=WETH&vs_currencies=usd"
      )
    )["data"]["weth"]["usd"]
  )
}

const RES_TOL_LOWER = 999990
const RES_TOL_UPPER = 1000010
const RES_TOL_TOTAL = 1000000

export function equalTol(a: BigNumber, b: BigNumber) {
  expect(a).gt(b.mul(RES_TOL_LOWER).div(RES_TOL_TOTAL))
  expect(a).lt(b.mul(RES_TOL_UPPER).div(RES_TOL_TOTAL))
}

export async function revSnapshot(id: string) {
  await network.provider.request({
    method: "evm_revert",
    params: [id],
  })

  return await network.provider.request({
    method: "evm_snapshot",
  })
}

export const noDeadline = Math.floor(Date.now() / 1000) * 2
