import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createWallet } from "./core/rpc.js"

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

test("debug nft buy", async () => {
  const sellerHome = makeHome()
  const buyerHome = makeHome()
  
  const r1 = await runCli(["nft", "mint", "ipfs://xyz"], sellerHome)
  console.log("MINT stdout:", r1.stdout)
  console.log("MINT stderr:", r1.stderr.slice(0, 200))
  
  const idMatch = r1.stdout.match(/#(\d+)/)
  console.log("ID match:", idMatch)
  
  const r2 = await runCli(["nft", "list", idMatch[1], "1000"], sellerHome)
  console.log("LIST stdout:", r2.stdout)
  console.log("LIST stderr:", r2.stderr.slice(0, 200))
  
  const r3 = await runCli(["nft", "buy", idMatch[1]], buyerHome)
  console.log("BUY stdout:", r3.stdout)
  console.log("BUY stderr:", r3.stderr.slice(0, 300))
  console.log("BUY code:", r3.code)
})
