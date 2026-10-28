import { spawn } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { createWallet } from "./core/rpc.js"
import { NFTMarketplace } from "./core/nft.js"

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
  console.log("MINT code:", r1.code)
  
  // Check DB after mint
  const nft1 = new NFTMarketplace()
  console.log("DB after mint - last NFT:", nft1.db.prepare("SELECT * FROM nfts ORDER BY id DESC LIMIT 1").get())
  console.log("DB after mint - last listing:", nft1.db.prepare("SELECT * FROM nft_listings ORDER BY id DESC LIMIT 1").get())
  
  const idMatch = r1.stdout.match(/#(\d+)/)
  const id = Number(idMatch[1])
  console.log("ID:", id)
  
  const r2 = await runCli(["nft", "list", String(id), "1000"], sellerHome)
  console.log("LIST:", r2.stdout.trim())
  console.log("LIST code:", r2.code)
  
  // Check DB after list
  const nft2 = new NFTMarketplace()
  console.log("DB after list - listing for nftId", id, ":", nft2.getListingByNft(id))
  console.log("DB after list - all listings:", nft2.db.prepare("SELECT * FROM nft_listings").all())
  
  const r3 = await runCli(["nft", "buy", String(id)], buyerHome)
  console.log("BUY:", r3.stdout.trim())
  console.log("BUY code:", r3.code)
}

main()
