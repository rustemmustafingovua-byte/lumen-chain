import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { createExplorerServer, snapshot } from "../cli/explorer.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { TX_FEE, FAUCET_ADDRESS } from "../core/ledger.js"

function fundedChain() {
  const chain = new Chain()
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  return { chain, val }
}

function startServer(chain: Chain, port = 0): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createExplorerServer({ chain })
    srv.listen(port, "127.0.0.1", () => {
      const addr = srv.address()
      const p = typeof addr === "object" && addr ? addr.port : port
      resolve({
        url: `http://127.0.0.1:${p}`,
        close: () => srv.close(),
      })
    })
  })
}

async function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, body: data }
}

// ---- faucet ----

test("faucet: без заголовка X-Address — 400", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/faucet`, { method: "POST" })
  assert.equal(r.status, 400)
  assert.ok(r.body.error)
  close()
})

test("faucet: с X-Address — выдает 10 000 LMN", async () => {
  const { chain, val: w } = fundedChain()
  const { url, close } = await startServer(chain)
  const before = chain.ledger.balance(w.address)
  const r = await request(`${url}/api/faucet`, {
    method: "POST",
    headers: { "X-Address": w.address },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.amount, "10000000000")
  assert.ok(r.body.tx)
  assert.equal(chain.ledger.balance(w.address), before + 10_000_000_000n)
  close()
})

test("faucet: тот же адрес может получить повторно", async () => {
  const { chain, val: w } = fundedChain()
  const { url, close } = await startServer(chain)
  const r1 = await request(`${url}/api/faucet`, { method: "POST", headers: { "X-Address": w.address } })
  assert.equal(r1.status, 200)
  const r2 = await request(`${url}/api/faucet`, { method: "POST", headers: { "X-Address": w.address } })
  assert.equal(r2.status, 200)
  close()
})

// ---- x402 payment scheme ----

test("x402: платный метод без заголовка — 402", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 402)
  assert.equal(r.body.error, "Payment required")
  assert.equal(r.body.asset, "LMN")
  close()
})

test("x402: платный метод с недостаточной оплатой — 402", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": "1" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 402)
  assert.equal(r.body.amount, 1000)
  close()
})

test("x402: платный метод с достаточной оплатой — 200", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const fakeTx = JSON.stringify({
    from: "lmn1test0000000000000000000000000000000000000000",
    to: "lmn1dest0000000000000000000000000000000000000000",
    amount: "1000",
    fee: "1000",
    nonce: 0,
    data: "",
    timestamp: Date.now(),
    signature: "",
  })
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  assert.equal(r.status, 200)
  assert.ok(r.body.result)
  close()
})

test("x402: бесплатный метод без оплаты — 200", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_blockNumber", params: [] }),
  })
  assert.equal(r.status, 200)
  assert.ok(r.body.result !== undefined)
  close()
})

test("x402: неизвестный метод — 400", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_noSuchMethod", params: [] }),
  })
  assert.equal(r.status, 400)
  assert.ok(r.body.error)
  close()
})

test("x402: contracts платный метод — 402 без оплаты", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_contracts", params: [] }),
  })
  assert.equal(r.status, 402)
  assert.equal(r.body.amount, 500)
  close()
})

test("x402: contract платный метод — 402 без оплаты", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_contract", params: ["0x" + "0".repeat(40)] }),
  })
  assert.equal(r.status, 402)
  assert.equal(r.body.amount, 200)
  close()
})

// ---- snapshot / state ----

test("snapshot возвращает корректную структуру", () => {
  const { chain } = fundedChain()
  const snap = snapshot(chain)
  assert.equal(typeof snap.chainId, "string")
  assert.equal(typeof snap.height, "number")
  assert.equal(typeof snap.supply, "string")
  assert.equal(typeof snap.pending, "number")
  assert.equal(Array.isArray(snap.blocks), true)
  assert.equal(Array.isArray(snap.accounts), true)
  assert.equal(Array.isArray(snap.transactions), true)
  assert.equal(Array.isArray(snap.pools), true)
  assert.equal(typeof snap.ts, "number")
})

test("/api/state возвращает snapshot", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/state`)
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.chainId, "string")
  close()
})

// ---- CORS / routing ----

test("CORS preflight возвращает 204", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/api/rpc`, { method: "OPTIONS" })
  assert.equal(r.status, 204)
  close()
})

test("неизвестный маршрут — 404", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await request(`${url}/no-such-route`)
  assert.equal(r.status, 404)
  close()
})
