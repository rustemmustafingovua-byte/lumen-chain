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
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { Chain } from "../core/chain.js"
import { makeRpc, createWallet, type Wallet, type RpcHandler } from "../core/rpc.js"
import { Gossip, createTcpTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { stringify } from "../core/ledger.js"
import { sha256, short } from "../core/crypto.js"
import { TX_FEE, FAUCET_ADDRESS } from "../core/ledger.js"
import { queueStake, queueSwap } from "../core/devnet.js"
import { AnalyticsStore } from "../core/analytics.js"
import { MetricsCollector } from "../core/metrics.js"
import { checkRateLimit, rateLimitMetrics } from "../core/rate-limiter.js"
import { verifySignature } from "../core/signer.js"

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
  corsOrigins?: string[]
  signingSecret?: string
  metrics?: MetricsCollector
  /** Enables /api/devnet/* . The devnet key is public; do not turn this on for a real network. */
  devnet?: boolean
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

/** HTTP-сервер с безопасностью: CORS, rate limit, подпись запросов, health/ready/metrics. */
export function createExplorerServer(opts: ExplorerOptions) {
  const { chain } = opts
  const rpc = makeRpc(chain)
  const analytics = new AnalyticsStore()
  const keys = opts.apiKeys ?? (process.env.LUMEN_API_KEYS ? process.env.LUMEN_API_KEYS.split(",").map(s => s.trim()).filter(Boolean) : [])
  analytics.initApiKeys(keys)
  const indexFile = join(EXPLORER_DIR, "index.html")
  const corsOrigins = opts.corsOrigins ?? (process.env.LUMEN_CORS_ORIGINS ? process.env.LUMEN_CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean) : [])
  const signingSecret = opts.signingSecret ?? process.env.LUMEN_SIGNING_SECRET ?? ""
  const startTime = Date.now()
  let requestCount = 0
  let errorCount = 0

  function setCors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin as string | undefined
    if (corsOrigins.length === 0) {
      res.setHeader("Access-Control-Allow-Origin", "*")
    } else if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin)
      res.setHeader("Vary", "Origin")
    } else if (origin) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "CORS blocked" }))
      return false
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*")
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST")
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key, x-payment, x-signature, x-timestamp")
    return true
  }

  function sanitize(input: unknown, maxLen = 256): unknown {
    if (typeof input === "string") {
      if (input.length > maxLen) throw new Error(`string too long: ${input.length} > ${maxLen}`)
      return input
    }
    if (Array.isArray(input)) {
      return input.map((v) => sanitize(v, maxLen))
    }
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input)) {
        if (k.length > 256) throw new Error(`key too long: ${k.length} > 256`)
        out[k] = sanitize(v, maxLen)
      }
      return out
    }
    return input
  }

  return createServer((req, res) => {
    const url = (req.url || "/").split("?")[0]
    const method = req.method || "GET"

    if (!setCors(req, res)) return
    if (req.method === "OPTIONS") return res.writeHead(204).end()

    // Rate limiting
    const ip = req.socket.remoteAddress
    const apiKey = req.headers["x-api-key"] as string | undefined
    const rl = checkRateLimit(ip, apiKey)
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfter))
      res.writeHead(429, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ error: "rate limit exceeded", retryAfter: rl.retryAfter }))
    }

    requestCount++

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
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
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

    if (url === "/demo" || url === "/demo.html") {
      const demoFile = join(EXPLORER_DIR, "demo.html")
      if (!existsSync(demoFile)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        return res.end("explorer/demo.html не найден")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(demoFile, "utf8"))
    }

    if (url === "/docs" || url === "/docs.html") {
      const docsFile = join(HERE, "..", "docs-site", "static", "docs.html")
      if (!existsSync(docsFile)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        return res.end("docs-site/static/docs.html не найден")
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(readFileSync(docsFile, "utf8"))
    }

    if (url === "/health") {
      const snap = snapshot(chain)
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({
        status: "ok",
        ts: Date.now(),
        uptime: Date.now() - startTime,
        height: snap.height,
        peers: opts.gossip?.peers.size ?? 0,
        mempool: chain.mempool.size,
        validators: snap.validators,
        totalStake: snap.totalStake,
      }))
    }

    if (url === "/ready") {
      const ready = chain.height > 0 && chain.head != null
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ ready, ts: Date.now(), height: chain.height }))
    }

    if (url === "/metrics") {
      const snap = snapshot(chain)
      const rlM = rateLimitMetrics()
      const lines = [
        `# HELP lumen_chain_height Current block height`,
        `# TYPE lumen_chain_height gauge`,
        `lumen_chain_height ${snap.height}`,
        `# HELP lumen_mempool_size Current mempool size`,
        `# TYPE lumen_mempool_size gauge`,
        `lumen_mempool_size ${chain.mempool.size}`,
        `# HELP lumen_validators Number of validators`,
        `# TYPE lumen_validators gauge`,
        `lumen_validators ${snap.validators}`,
        `# HELP lumen_total_stake Total staked LMN`,
        `# TYPE lumen_total_stake gauge`,
        `lumen_total_stake ${snap.totalStake}`,
        `# HELP lumen_rate_limit_active Active rate limit buckets`,
        `# TYPE lumen_rate_limit_active gauge`,
        `lumen_rate_limit_active{type="free"} ${rlM.freeActive}`,
        `lumen_rate_limit_active{type="key"} ${rlM.keyActive}`,
        `# HELP lumen_requests_total Total HTTP requests`,
        `# TYPE lumen_requests_total counter`,
        `lumen_requests_total ${requestCount}`,
        `# HELP lumen_errors_total Total handler errors`,
        `# TYPE lumen_errors_total counter`,
        `lumen_errors_total ${errorCount}`,
      ]
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" })
      return res.end(lines.join("\n") + "\n")
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
        } catch { }
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify(snap))
    }

    if (url === "/api/metrics" && opts.metrics) {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(opts.metrics.toJson())
    }

    if (url === "/api/faucet") {
      if (method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: "Method Not Allowed" }))
      }
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
      if (method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: "Method Not Allowed" }))
      }
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        let method = ""
        let params: any[] = []
        let paymentHeader = req.headers["x-payment"] as string | undefined
        const apiKeyHeader = req.headers["x-api-key"] as string | undefined
        let rawBody = ""
        try {
          rawBody = Buffer.concat(chunks).toString() || "{}"
          const body = JSON.parse(rawBody)
          method = body.method || ""
          params = body.params || []
        } catch {
          /* пустой запрос */
        }

        // Request signing check
        if (signingSecret) {
          const tsHeader = req.headers["x-timestamp"] as string | undefined
          const sigHeader = req.headers["x-signature"] as string | undefined
          if (!tsHeader || !sigHeader) {
            res.writeHead(401, { "Content-Type": "application/json" })
            return res.end(JSON.stringify({ error: "Missing X-Timestamp or X-Signature" }))
          }
          const ts = Number(tsHeader)
          if (!verifySignature(signingSecret, method, rawBody, ts, sigHeader)) {
            res.writeHead(401, { "Content-Type": "application/json" })
            return res.end(JSON.stringify({ error: "Invalid signature" }))
          }
        }

        // Input validation
        if (!method) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ error: "missing method" }))
        }
        const allowedPrefix = "lumen_"
        if (!method.startsWith(allowedPrefix)) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ error: "unknown method prefix" }))
        }
        try {
          params = sanitize(params) as any[]
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" })
          return res.end(JSON.stringify({ error: (e as Error).message }))
        }

        // x402 scheme: paid methods require x-payment header with LMN amount
        const paidMethods: Record<string, number> = {
          "lumen_sendRawTransaction": 1000,
          "lumen_contracts": 500,
          "lumen_contract": 200,
        }
        const requiredFee = paidMethods[method]
        if (requiredFee) {
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
          errorCount++
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

    if (opts.devnet && url === "/api/devnet/info" && method === "GET") {
      const address = opts.wallet?.address ?? ""
      const pool = chain.ledger.pool("LMN/USDC")
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({
        network: "devnet",
        chainId: rpc("lumen_chainId"),
        address,
        height: chain.height,
        balance: address ? chain.ledger.balance(address).toString() : "0",
        stake: address ? chain.ledger.get(address).stake.toString() : "0",
        usdc: address ? chain.ledger.assetBalance(address, "USDC").toString() : "0",
        mempool: chain.mempool.size,
        pool: pool
          ? { base: pool.base.toString(), quote: pool.quote.toString(), feeBps: pool.feeBps.toString() }
          : null,
        warning: "Devnet validator key is public. USDC is an internal unit, not a bridged asset.",
      }))
    }

    if (opts.devnet && method === "POST" && (url === "/api/devnet/stake" || url === "/api/devnet/swap")) {
      readBody(req).then((raw) => {
        try {
          if (!opts.wallet) throw new Error("devnet wallet is not configured")
          const body = raw ? JSON.parse(raw) as { amount?: string; direction?: string } : {}
          if (body.amount == null || body.amount === "") throw new Error("amount is required")
          const amount = BigInt(body.amount)
          const tx = url.endsWith("/stake")
            ? queueStake(chain, opts.wallet, amount)
            : queueSwap(chain, opts.wallet, body.direction === "buy" ? "buy" : "sell", amount)
          res.writeHead(202, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            status: "queued",
            nonce: tx.nonce,
            amount: tx.amount.toString(),
            fee: tx.fee.toString(),
            data: tx.data ?? "",
          }))
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      }).catch((e) => {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: (e as Error).message }))
      })
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
  })
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
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
