import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { createExplorerServer } from "../cli/explorer.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"

function fundedChain() {
  const chain = new Chain()
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)
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

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url)
  const text = await res.text()
  return { status: res.status, body: text }
}

// ---- HTML pages ----

test("GET / — explorer index.html", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/`)
  assert.equal(r.status, 200)
  assert.ok(r.body.includes("<!DOCTYPE html") || r.body.includes("<html"))
  close()
})

test("GET /index.html — alias", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/index.html`)
  assert.equal(r.status, 200)
  assert.ok(r.body.includes("<!DOCTYPE html") || r.body.includes("<html"))
  close()
})

test("GET /wallet — wallet.html", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/wallet`)
  assert.equal(r.status, 200)
  assert.ok(r.body.includes("<!DOCTYPE html") || r.body.includes("<html"))
  close()
})

test("GET /wallet.html — alias", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/wallet.html`)
  assert.equal(r.status, 200)
  close()
})

test("GET /landing — landing.html", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/landing`)
  assert.equal(r.status, 200)
  assert.ok(r.body.includes("<!DOCTYPE html") || r.body.includes("<html"))
  close()
})

test("GET /dashboard — dashboard.html", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/dashboard`)
  assert.equal(r.status, 200)
  assert.ok(r.body.includes("<!DOCTYPE html") || r.body.includes("<html"))
  close()
})

// ---- wallet page содержит JS для работы с кошельком ----

test("wallet.html содержит элементы для отправки транзакции", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/wallet`)
  assert.equal(r.status, 200)
  const hasForm = r.body.includes("<form") || r.body.includes("send") || r.body.includes("button")
  assert.ok(hasForm, "wallet.html должен содержать элементы формы или кнопки")
  close()
})

// ---- dashboard обновляет данные через /api/state ----

test("dashboard HTML содержит ссылку на API состояния", async () => {
  const { chain } = fundedChain()
  const { url, close } = await startServer(chain)
  const r = await get(`${url}/dashboard`)
  assert.equal(r.status, 200)
  const fetchesApi = r.body.includes("/api/state") || r.body.includes("api/state")
  assert.ok(fetchesApi, "dashboard должен подгружать /api/state")
  close()
})
