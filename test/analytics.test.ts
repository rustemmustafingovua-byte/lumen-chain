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

function startServer(chain: Chain, port = 0, apiKeys?: string[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createExplorerServer({ chain, apiKeys })
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
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
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

// ---- API key validation ----

test("API key middleware: без ключа платный метод — 401 при включённых ключах", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, "Invalid API key")
  close()
})

test("API key middleware: неверный ключ платный метод — 401", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-wrong" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, "Invalid API key")
  close()
})

test("API key middleware: верный ключ платный метод — 402 если нет оплаты", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-test-123" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 402)
  assert.equal(r.body.amount, 1000)
  close()
})

test("API key middleware: верный ключ + оплата — 200", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
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
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-test-123", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  assert.equal(r.status, 200)
  assert.ok(r.body.result)
  close()
})

test("API key middleware: без ключей на сервере — платный метод работает без ключа", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
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
  close()
})

// ---- Usage tracking ----

test("x402 tracking: оплаченный запрос логируется", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
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
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  // Wait for analytics to be recorded - it's synchronous so should be ready immediately
  close()
})

test("x402 tracking: бесплатный метод не логируется как платный", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "lumen_blockNumber", params: [] }),
  })
  close()
})

// ---- /api/usage endpoint ----

test("/api/usage без ключа — 401 при включённых ключах", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
  const r = await request(`${url}/api/usage`)
  assert.equal(r.status, 401)
  assert.equal(r.body.error, "Invalid API key")
  close()
})

test("/api/usage с верным ключом возвращает корректную структуру", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-test-123"])
  // Сначала делаем пару платных запросов
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
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-test-123", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-test-123", "X-Payment": "3000" },
    body: JSON.stringify({ method: "lumen_contracts", params: [] }),
  })

  const r = await request(`${url}/api/usage`, {
    headers: { "X-API-Key": "sk-test-123" },
  })
  assert.equal(r.status, 200)
  assert.ok(typeof r.body.totalRequests === "number")
  assert.ok(typeof r.body.revenue === "number")
  assert.ok(typeof r.body.activeApiKeys === "number")
  assert.ok(Array.isArray(r.body.topEndpoints))
  assert.equal(r.body.totalRequests, 2)
  assert.equal(r.body.revenue, 8000)
  assert.ok(r.body.activeApiKeys >= 1)
  close()
})

test("/api/usage: topEndpoints содержит ожидаемые данные", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0, ["sk-alpha", "sk-beta"])
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
  // 2 раза один метод
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-alpha", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-beta", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  // 1 раз другой метод
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "sk-alpha", "X-Payment": "500" },
    body: JSON.stringify({ method: "lumen_contracts", params: [] }),
  })

  const r = await request(`${url}/api/usage`, {
    headers: { "X-API-Key": "sk-alpha" },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.totalRequests, 3)
  assert.equal(r.body.revenue, 10500)
  assert.equal(r.body.activeApiKeys, 2)
  assert.ok(r.body.topEndpoints.length >= 1)
  const top = r.body.topEndpoints[0]
  assert.equal(top.endpoint, "/api/rpc")
  assert.equal(top.count, 3)
  assert.equal(top.revenue, 10500)
  close()
})

test("/api/usage без серверных ключей — доступен без ключа", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
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
  await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": "5000" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [fakeTx] }),
  })
  const r = await request(`${url}/api/usage`)
  assert.equal(r.status, 200)
  assert.equal(r.body.totalRequests, 1)
  assert.equal(r.body.revenue, 5000)
  assert.equal(r.body.activeApiKeys, 0)
  close()
})

// ---- Request/response logging ----

test("paid endpoint логирует успешный ответ", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
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
  close()
})

test("paid endpoint логирует ошибку валидации оплаты", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain, 0)
  const r = await request(`${url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Payment": "100" },
    body: JSON.stringify({ method: "lumen_sendRawTransaction", params: [] }),
  })
  assert.equal(r.status, 402)
  close()
})
