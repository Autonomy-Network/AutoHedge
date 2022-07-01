import fs from "fs"
import axios from "axios"
import { expect } from "chai"
import { BigNumber, ContractInterface } from "ethers"
import { network } from "hardhat"

export const noDeadline = Math.floor(Date.now() / 1000) * 2

export type ArtifactType = {
  address: string
  abi: ContractInterface
}

export type UnitrollerSnapshot = {
  snapshotId: string
  unitroller: string
  reg: string
  uff: string
  oracle: string
}

export const defaultDepositEvent = {
  amountStable: BigNumber.from(0),
  amountUniLp: BigNumber.from(0),
  amountVol: BigNumber.from(0),
}

export const JUMP_RATE_MODEL_ADDR = "0xbAB47e4B692195BF064923178A90Ef999A15f819"
export const JUMP_RATE_MODEL_UNI_ADDR =
  "0xc35DB333EF7ce4F246DE9DE11Cc1929d6AA11672" // noinspection SpellCheckingInspection
export const CERC20_IMPLEMENTATION_ADDR =
  "0x67Db14E73C2Dce786B5bbBfa4D010dEab4BBFCF9"

export function getAddresses(): UnitrollerSnapshot {
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

export async function snapshot(): Promise<string> {
  const snapshotId = await network.provider.request({
    method: "evm_snapshot",
  })

  return snapshotId as string
}

export async function revertSnapshot(id: string) {
  await network.provider.request({
    method: "evm_revert",
    params: [id],
  })
}

export async function revertAndSnapshot(id: string): Promise<string> {
  await revertSnapshot(id)

  return snapshot()
}

export async function increaseTime(time: number) {
  await network.provider.send("evm_increaseTime", [time])
}
