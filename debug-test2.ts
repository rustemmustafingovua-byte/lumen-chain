import { spawn } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { createWallet } from "./core/rpc.js"
import { NFTMarketplace } from "./core/nft.js"
import { Ledger } from "./core/ledger.js"

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "")
}

function runCli(args: string[], envHome?: string) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: envHome ?? process.env.HOME ?? tmpdir() }
    const LUMEN_TS = join(process.cwd(), "cli", "lumen.ts")
    const TSX = process.execPath
    const ARGS = [join(process.cwd(), "node_modules", ".bin", "tsx")]
    const child = spawn(TSX, [...ARGS, LUMEN_TS, ...args], { env })
    let stdout = "", stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("close", (code) => resolve({ code: code ?? 0, stdout: stripAnsi(stdout), stderr }))
  })
}

function makeHome() {
  const dir = join(tmpdir(), `lumen-defi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, ".lumen"), { recursive: true })
  const w = createWallet()
  writeFileSync(join(dir, ".lumen", "wallet.json"), JSON.stringify(w))
  return dir
}

async function main() {
  const sellerHome = makeHome()
  const buyerHome = makeHome()
  
  const r1 = await runCli(["nft", "mint", "ipfs://xyz"], sellerHome)
  console.log("MINT:", r1.stdout.trim())
  
  const idMatch = r1.stdout.match(/#(\d+)/)
  const id = Number(idMatch[1])
  console.log("ID:", id)
  
  const r2 = await runCli(["nft", "list", String(id), "1000"], sellerHome)
  console.log("LIST:", r2.stdout.trim())
  
  // Check DB directly
  const nft = new NFTMarketplace()
  const listing = nft.getListingByNft(id)
  console.log("Direct DB check - listing:", listing)
  
  const r3 = await runCli(["nft", "buy", String(id)], buyerHome)
  console.log("BUY:", r3.stdout.trim(), "code:", r3.code)
}

main()
