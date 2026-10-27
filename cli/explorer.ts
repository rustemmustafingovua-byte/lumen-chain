#!/usr/bin/env node
/**
 * Lumen Explorer — веб-интерфейс сети.
 *
 * Отдаётся самим узлом (`lumen serve`), поэтому страница всегда показывает
 * живое состояние цепочки, а не статичный снимок.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { Chain } from "../core/chain.js"
import { makeRpc, createWallet, type Wallet } from "../core/rpc.js"
import { Gossip, createTcpTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { stringify } from "../core/ledger.js"
import { sha256, short } from "../core/crypto.js"
import { TX_FEE, FAUCET_ADDRESS } from "../core/ledger.js"
import { AnalyticsStore } from "../core/analytics.js"

const HERE = dirname(fileURLToPath(import.meta.url))
/** Ищем каталог explorer: и в исходниках, и в собранном пакете. */
function findExplorerDir(): string {
  const candidates = [
    join(HERE, "..", "explorer"),
    join(HERE, "..", "..", "explorer"),
    join(HERE, "..", "..", "..", "explorer"),
  ]
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c
  return candidates[0]
}
const EXPLORER_DIR = findExplorerDir()

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

export type ExplorerOptions = {
  chain: Chain
  wallet?: Wallet
  gossip?: Gossip
  port?: number
  host?: string
  apiKeys?: string[]
}

/** Снимок состояния для интерфейса. */
export function snapshot(chain: Chain) {
  const rpc = makeRpc(chain)
  const blocks = chain.blocks.slice(-25).map((b) => ({
    height: b.header.height,
    hash: b.hash.slice(0, 16),
    fullHash: b.hash,
    proposer: b.header.proposer.slice(0, 12),
    txs: b.txs.length,
    timestamp: b.header.timestamp,
    merkleRoot: b.header.merkleRoot.slice(0, 12),
  }))
  const accounts = [...chain.ledger.accounts.values()]
    .filter((a) => a.balance > 0n || a.stake > 0n)
    .map((a) => ({
      address: a.address,
      short: short(a.address),
      balance: a.balance.toString(),
      stake: a.stake.toString(),
      nonce: a.nonce,
    }))
    .sort((x, y) => (BigInt(x.balance) > BigInt(y.balance) ? -1 : 1))
    .slice(0, 20)
  const transactions = chain.blocks
    .slice(-25)
    .flatMap((b) =>
      b.txs.map((t) => ({
        height: b.header.height,
        from: t.from,
        to: t.to ?? null,
        amount: t.amount.toString(),
        fee: t.fee.toString(),
        nonce: t.nonce,
        data: t.data ?? "",
        hash: sha256(stringify(t)).slice(0, 16),
      })),
    )
    .slice(-30)
    .reverse()
  const contracts = [...chain.ledger.contracts.entries()].map(([addr, c]) => ({
    address: addr,
    codeSize: c.code.length,
    balance: c.balance.toString(),
    storage: Object.fromEntries([...c.storage.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  }))
  const pools = [...chain.ledger.pools.entries()].map(([key, p]) => ({
    key,
    base: p.base.toString(),
    quote: p.quote.toString(),
    feeBps: p.feeBps.toString(),
    totalShares: p.totalShares.toString(),
  }))
  return {
    chainId: rpc("lumen_chainId"),
    height: rpc("lumen_blockNumber"),
    supply: rpc("lumen_totalSupply"),
    stateRoot: rpc("lumen_stateRoot"),
    pending: chain.mempool.size,
    validators: chain.validators.size,
    totalStake: chain.totalStake().toString(),
    blocks,
    accounts,
    pools,
    transactions,
    contracts,
    ts: Date.now(),
  }
}

/** HTTP-сервер: / — explorer, /api/state — снимок, /api/rpc — JSON-RPC. */
export function createExplorerServer(opts: ExplorerOptions) {
  const { chain } = opts
  const rpc = makeRpc(chain)
  const analytics = new AnalyticsStore()
  const keys = opts.apiKeys ?? (process.env.LUMEN_API_KEYS ? process.env.LUMEN_API_KEYS.split(",").map(s => s.trim()).filter(Boolean) : [])
  analytics.initApiKeys(keys)
  const indexFile = join(EXPLORER_DIR, "index.html")

  return createServer((req, res) => {
    const url = (req.url || "/").split("?")[0]
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "content-type")
    if (req.method === "OPTIONS") return res.writeHead(204).end()

    if (url === "/" || url === "/index.html") {
      if (!existsSync(indexFile)) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        return res.end("explorer/index.html не найден")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(indexFile, "utf8"))
    }

    if (url === "/wallet" || url === "/wallet.html") {
      const walletFile = join(EXPLORER_DIR, "wallet.html")
      if (!existsSync(walletFile)) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        return res.end("wallet.html not found")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(walletFile, "utf8"))
    }

    if (url === "/landing" || url === "/landing.html") {
      const landingFile = join(EXPLORER_DIR, "landing.html")
      if (!existsSync(landingFile)) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        return res.end("landing.html not found")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(landingFile, "utf8"))
    }

    if (url === "/dashboard" || url === "/dashboard.html") {
      const dashFile = join(EXPLORER_DIR, "dashboard.html")
      if (!existsSync(dashFile)) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        return res.end("explorer/dashboard.html не найден")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(dashFile, "utf8"))
    }

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ status: "ok", ts: Date.now() }))
    }

    if (url === "/api/state") {
      const snap = snapshot(chain)
      const webhook = process.env.DASHBOARD_WEBHOOK_URL
      if (webhook) {
        try {
          const body = JSON.stringify({
            blocks: snap.height,
            supply: snap.supply,
            validators: snap.validators,
            staked: snap.totalStake,
          })
          fetch(webhook + "/webhook/lumen-chain", { method: "POST", headers: { "content-type": "application/json" }, body })
            .catch(() => {})
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify(snap))
    }

    if (url === "/api/faucet") {
      const to = req.headers["x-address"] as string | undefined
      if (!to) {
        res.writeHead(400, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: "X-Address header required" }))
      }
      const amount = 10_000_000_000n // 10 000 LMN
      const faucetAccount = chain.ledger.get(FAUCET_ADDRESS)
      const tx = {
        from: FAUCET_ADDRESS,
        to,
        amount,
        fee: TX_FEE,
        nonce: faucetAccount.nonce,
        data: "faucet",
        timestamp: Date.now(),
        signature: "",
      } as any
      try {
        chain.ledger.apply(tx)
        chain.persistState()
        const txHash = sha256(stringify(tx))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ tx: txHash, amount: amount.toString() }))
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: String((e as Error).message) }))
      }
      return
    }

    if (url === "/api/rpc") {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        let method = ""
        let params: any[] = []
        let paymentHeader = req.headers["x-payment"] as string | undefined
        const apiKeyHeader = req.headers["x-api-key"] as string | undefined
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
          method = body.method || ""
          params = body.params || []
        } catch {
          /* пустой запрос */
        }

        // x402 scheme: paid methods require x-payment header with LMN amount
        const paidMethods: Record<string, number> = {
          "lumen_sendRawTransaction": 1000,
          "lumen_contracts": 500,
          "lumen_contract": 200,
        }
        const requiredFee = paidMethods[method]
        if (requiredFee) {
          // API key validation
          if (!analytics.validateApiKey(apiKeyHeader || "")) {
            console.log(`\x1b[2m[auth] отклонён ключ ${apiKeyHeader} для ${method}\x1b[0m`)
            res.writeHead(401, { "Content-Type": "application/json" })
            return res.end(JSON.stringify({ error: "Invalid API key", method }))
          }
          const paid = Number(paymentHeader || "0")
          if (paid < requiredFee) {
            res.writeHead(402, { "Content-Type": "application/json" })
            return res.end(JSON.stringify({
              error: "Payment required",
              amount: requiredFee,
              asset: "LMN",
              message: `Send ${requiredFee} LMN to treasury address`
            }))
          }
        }

        try {
          const out = rpc(method, params)
          if (requiredFee) {
            const paid = Number(paymentHeader || "0")
            analytics.record({
              method,
              endpoint: "/api/rpc",
              apiKey: apiKeyHeader,
              payment: paid,
              status: 200,
            })
            analytics.touchKey(apiKeyHeader || "")
            console.log(`\x1b[2m[analytics] ${method}: оплачено ${paid} LMN, ключ: ${apiKeyHeader || "нет"}\x1b[0m`)
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ result: out }))
        } catch (e) {
          if (requiredFee) {
            analytics.record({
              method,
              endpoint: "/api/rpc",
              apiKey: apiKeyHeader,
              payment: Number(paymentHeader || "0"),
              status: 400,
            })
          }
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: String((e as Error).message) }))
        }
      })
      return
    }

    if (url === "/api/usage") {
      const apiKeyHeader = req.headers["x-api-key"] as string | undefined
      if (!analytics.validateApiKey(apiKeyHeader || "")) {
        res.writeHead(401, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: "Invalid API key" }))
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify(analytics.getUsageSummary()))
    }

    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
  })
}

/** Запуск explorer + RPC-сервера. */
export async function serveExplorer(opts: ExplorerOptions & { walletPath?: string }) {
  const port = opts.port ?? 8899
  const host = opts.host ?? "0.0.0.0"
  const server = createExplorerServer(opts)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const actual = (server.address() as any)?.port ?? port
  console.log(ok(`explorer: http://127.0.0.1:${actual}  (api: /api/state, /api/rpc)`))
  return { server, port: actual }
}
