import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { Gossip, createMemoryBus, createMemoryTransport, peerIdFromPublicKey, toWireBlock, fromWireBlock } from "../core/p2p.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"

/**
 * В сети набор валидаторов известен всем узлам (часть генезиса),
 * поэтому каждый узел регистрирует всех валидаторов сети.
 */
function makeNetwork(count: number) {
  const bus = createMemoryBus()
  const validators = Array.from({ length: count }, () => createWallet())
  const nodes = validators.map((v, i) => {
    const chain = new Chain()
    chain.genesis()
    // одинаковое состояние генезиса на всех узлах: все валидаторы получают средства
    for (const val of validators) {
      chain.ledger.get(val.address).balance = 1_000_000_000_000n
      chain.ledger.get(val.address).publicKey = val.publicKey
      chain.addValidator(val.publicKey, MIN_STAKE * 10n)
    }
    const transport = createMemoryTransport(bus)
    const gossip = new Gossip(chain, {
      peerId: peerIdFromPublicKey(v.publicKey),
      pubkey: v.publicKey,
      transport,
    })
    gossip.start()
    bus.register(String.fromCharCode(97 + i), transport) // адреса: "a", "b", "c"
    return { chain, w: v, transport, gossip }
  })
  return { nodes, validators, bus }
}

/** Прогнать все накопленные сообщения по очереди. */
function flush(net: ReturnType<typeof makeNetwork>, rounds = 4) {
  for (let i = 0; i < rounds; i++) net.bus.flush()
}

test("генезис у всех узлов одинаковый (иначе цепь разошлась бы с первого блока)", () => {
  const net = makeNetwork(3)
  const hashes = net.nodes.map((n) => n.chain.blocks[0].hash)
  assert.equal(new Set(hashes).size, 1, "хеш генезиса должен совпадать у всех узлов")
})

test("gossip: узел объявляет себя соседям", () => {
  const net = makeNetwork(2)
  const [a, b] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  flush(net)
  assert.ok(a.gossip.peers.has("b"))
  assert.ok(b.gossip.peers.has("a"))
  assert.equal(a.gossip.peers.get("b"), 0)
})

test("gossip: блок от соседа принимается и высота растёт", () => {
  const net = makeNetwork(2)
  const [a, b] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  flush(net)

  const tx = buildTx(b.w, createWallet().address, 5n, { nonce: 0 })
  const block = b.chain.propose([tx], b.w.privateKey, b.w.publicKey, 1)
  b.chain.accept(block)
  b.gossip.broadcastBlock(block)
  flush(net)

  assert.equal(a.chain.height, 1)
  assert.equal(a.chain.head!.hash, block.hash)
})

test("gossip: узел догоняет соседа, у которого больше блоков", () => {
  const net = makeNetwork(2)
  const [a, b] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  flush(net)

  for (let i = 1; i <= 2; i++) {
    const tx = buildTx(b.w, createWallet().address, 5n, { nonce: i - 1 })
    const block = b.chain.propose([tx], b.w.privateKey, b.w.publicKey, i)
    b.chain.accept(block)
  }
  assert.equal(b.chain.height, 2)
  assert.equal(a.chain.height, 0)

  // a переподключается: получает hello с высотой 2 и просит недостающие блоки
  a.gossip.connect("b")
  flush(net, 6)

  assert.equal(a.chain.height, 2, "узел должен догнать соседа")
  assert.equal(a.chain.head!.hash, b.chain.head!.hash)
})

test("gossip: невалидный блок отклоняется", () => {
  const net = makeNetwork(2)
  const [a, b] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  flush(net)

  const tx = buildTx(b.w, createWallet().address, 5n, { nonce: 0 })
  const block = b.chain.propose([tx], b.w.privateKey, b.w.publicKey, 1)
  const bad = { ...block, signature: "AAAA" }
  a.gossip.handle("b", JSON.stringify({ type: "block", block: toWireBlock(bad) }))
  assert.equal(a.chain.height, 0)
})

test("gossip: блок доходит через посредника", () => {
  const net = makeNetwork(3)
  const [a, b, c] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  b.gossip.connect("c")
  c.gossip.connect("b")
  flush(net)

  const tx = buildTx(b.w, createWallet().address, 5n, { nonce: 0 })
  const block = b.chain.propose([tx], b.w.privateKey, b.w.publicKey, 1)
  b.chain.accept(block)
  b.gossip.broadcastBlock(block)
  flush(net)

  assert.equal(a.chain.height, 1)
  assert.equal(c.chain.height, 1, "блок должен дойти через посредника")
})

test("gossip: состояние узлов совпадает после синхронизации", () => {
  const net = makeNetwork(2)
  const [a, b] = net.nodes
  a.gossip.connect("b")
  b.gossip.connect("a")
  flush(net)

  for (let i = 1; i <= 3; i++) {
    const tx = buildTx(b.w, createWallet().address, 5n, { nonce: i - 1 })
    const block = b.chain.propose([tx], b.w.privateKey, b.w.publicKey, i)
    b.chain.accept(block)
  }
  a.gossip.connect("b")
  flush(net, 8)
  assert.equal(a.chain.height, b.chain.height)
  assert.equal(a.chain.ledger.stateRoot(), b.chain.ledger.stateRoot())
})

test("gossip: сериализация блока сохраняет bigint", () => {
  const net = makeNetwork(1)
  const a = net.nodes[0]
  const tx = buildTx(a.w, createWallet().address, 123456n, { nonce: 0 })
  const block = a.chain.propose([tx], a.w.privateKey, a.w.publicKey, 1)
  const wire = toWireBlock(block)
  assert.equal(typeof wire.txs[0].amount, "string")
  const back = fromWireBlock(wire)
  assert.equal(back.txs[0].amount, 123456n)
  assert.equal(back.hash, block.hash)
})
