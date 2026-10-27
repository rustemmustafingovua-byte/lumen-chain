import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain, SLOT_MS } from "../core/chain.js"
import { Gossip, createMemoryBus, createMemoryTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { createWallet, buildTx, makeRpc } from "../core/rpc.js"
import { MIN_STAKE, TX_FEE } from "../core/ledger.js"
import { createNode, connectPeers, sendTx, fundNode, countMessages } from "./helpers/node.js"
import { waitForHeight } from "./helpers/wait.js"
import { assertBlockPropagated, assertConsensusReached, assertBalance, assertValidatorStaked } from "./helpers/assert.js"

/* =========================================================================
 * e2e: 3 узла, P2P, транзакции, консенсус, распространение блоков,
 *       восстановление после сетевого раздела.
 * ========================================================================= */

const NODE_COUNT = 3
const NETWORK_TIMEOUT = 10_000
const BUS_FLUSH_ROUNDS = 6

/** Вспомогательная: создать сеть из N узлов и убедиться, что все соединились. */
async function setupNetwork(nodeCount: number) {
  const bus = createMemoryBus()
  const addrs = Array.from({ length: nodeCount }, (_, i) => `node-${String.fromCharCode(97 + i)}`)
  const nodes = addrs.map((addr) => createNode(bus, addr))

  // полный граф
  for (const node of nodes) {
    connectPeers(node, nodes.filter((n) => n.addr !== node.addr))
  }
  // доставляем hello-сообщения
  for (let i = 0; i < BUS_FLUSH_ROUNDS; i++) bus.flush()

  await waitForHeight(
    () => nodes.every((n) => n.gossip.peers.size === nodeCount - 1) ? 1 : 0,
    1,
    { timeoutMs: 2000, label: "peers connected" },
  )
  return { bus, nodes }
}

/** Доставить все накопленные сообщения шиной. */
function flushBus(bus: ReturnType<typeof createMemoryBus>, rounds = BUS_FLUSH_ROUNDS): void {
  for (let i = 0; i < rounds; i++) bus.flush()
}

test("e2e: 3 узла поднимаются и соединяются по P2P", async () => {
  const { nodes } = await setupNetwork(NODE_COUNT)

  assert.equal(nodes[0].gossip.peers.size, 2)
  assert.equal(nodes[1].gossip.peers.size, 2)
  assert.equal(nodes[2].gossip.peers.size, 2)

  for (const n of nodes) {
    assert.equal(n.chain.height, 0)
  }
})

test("e2e: транзакция отправляется и включается в блок", async () => {
  const { bus, nodes } = await setupNetwork(NODE_COUNT)
  const [a, b, c] = nodes
  const recipient = createWallet().address

  // b майнит блок с одной транзакцией к recipient
  const tx = buildTx(b.wallet, recipient, 500n, { nonce: 0 })
  b.chain.mempool.add(tx)
  const txs = b.chain.mempool.take(100)
  const block = b.chain.propose(txs, b.wallet.privateKey, b.wallet.publicKey, b.chain.blocks.length)
  b.chain.accept(block)
  b.gossip.broadcastBlock(block)
  flushBus(bus)

  await waitForHeight(() => a.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "a sync" })
  await waitForHeight(() => c.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "c sync" })

  assert.equal(a.chain.height, 1)
  assert.equal(c.chain.height, 1)
  assert.equal(b.chain.ledger.balance(recipient), 500n)
  assert.equal(a.chain.head!.hash, b.chain.head!.hash)
  assert.equal(c.chain.head!.hash, b.chain.head!.hash)
})

test("e2e: все узлы синхронизируются до одинаковой высоты", async () => {
  const { bus, nodes } = await setupNetwork(NODE_COUNT)
  const [n1, , n3] = nodes

  // n1 майнит 3 блока
  for (let i = 1; i <= 3; i++) {
    const tx = buildTx(n1.wallet, createWallet().address, 10n, { nonce: i - 1 })
    n1.chain.mempool.add(tx)
    const txs = n1.chain.mempool.take(100)
    const block = n1.chain.propose(txs, n1.wallet.privateKey, n1.wallet.publicKey, n1.chain.blocks.length)
    n1.chain.accept(block)
    n1.gossip.broadcastBlock(block)
    flushBus(bus)
  }

  await waitForHeight(() => nodes[0].chain.height, 3, { timeoutMs: NETWORK_TIMEOUT, label: "n1 height" })
  await waitForHeight(() => nodes[1].chain.height, 3, { timeoutMs: NETWORK_TIMEOUT, label: "n2 height" })
  await waitForHeight(() => nodes[2].chain.height, 3, { timeoutMs: NETWORK_TIMEOUT, label: "n3 height" })

  assert.equal(nodes[0].chain.height, 3)
  assert.equal(nodes[1].chain.height, 3)
  assert.equal(nodes[2].chain.height, 3)
  assert.equal(nodes[0].chain.ledger.stateRoot(), nodes[1].chain.ledger.stateRoot())
  assert.equal(nodes[1].chain.ledger.stateRoot(), nodes[2].chain.ledger.stateRoot())
})

test("e2e: консенсус достигнут после нескольких блоков", async () => {
  const { bus, nodes } = await setupNetwork(NODE_COUNT)
  const [a, b, c] = nodes

  const rounds = 3
  for (let r = 0; r < rounds; r++) {
    for (const node of [a, b, c]) {
      const tx = buildTx(node.wallet, createWallet().address, 1n, { nonce: r })
      node.chain.mempool.add(tx)
      const txs = node.chain.mempool.take(100)
      const block = node.chain.propose(txs, node.wallet.privateKey, node.wallet.publicKey, node.chain.blocks.length)
      node.chain.accept(block)
      node.gossip.broadcastBlock(block)
    }
    flushBus(bus)
  }

  await waitForHeight(() => nodes[0].chain.height, rounds * NODE_COUNT, { timeoutMs: NETWORK_TIMEOUT * 2, label: "height" })

  assert.equal(a.chain.height, b.chain.height)
  assert.equal(b.chain.height, c.chain.height)
  assert.equal(a.chain.ledger.stateRoot(), c.chain.ledger.stateRoot())
})

test("e2e: восстановление после сетевого раздела", async () => {
  const bus = createMemoryBus()
  const addrs = ["ra", "rb", "rc"]
  const nodes = addrs.map((addr) => createNode(bus, addr))
  for (const node of nodes) {
    connectPeers(node, nodes.filter((n) => n.addr !== node.addr))
  }
  flushBus(bus)

  const [ra, rb, rc] = nodes

  // разбиваем сеть: ra и rb отдельно, rc отдельно
  ra.gossip.peers.delete("rb"); ra.gossip.peers.delete("rc")
  rb.gossip.peers.delete("ra"); rb.gossip.peers.delete("rc")
  rc.gossip.peers.delete("ra"); rc.gossip.peers.delete("rb")

  // партия A: ra и rb майнят по 2 блока
  for (let i = 0; i < 2; i++) {
    for (const node of [ra, rb]) {
      const tx = buildTx(node.wallet, createWallet().address, 1n, { nonce: i })
      node.chain.mempool.add(tx)
      const txs = node.chain.mempool.take(100)
      const block = node.chain.propose(txs, node.wallet.privateKey, node.wallet.publicKey, node.chain.blocks.length)
      node.chain.accept(block)
      node.gossip.broadcastBlock(block)
    }
    flushBus(bus)
  }
  // партия B: rc майнит 1 блок
  const txRc = buildTx(rc.wallet, createWallet().address, 1n, { nonce: 0 })
  rc.chain.mempool.add(txRc)
  const txsRc = rc.chain.mempool.take(100)
  const blockRc = rc.chain.propose(txsRc, rc.wallet.privateKey, rc.wallet.publicKey, rc.chain.blocks.length)
  rc.chain.accept(blockRc)
  rc.gossip.broadcastBlock(blockRc)
  flushBus(bus)

  assert.equal(ra.chain.height, 2)
  assert.equal(rb.chain.height, 2)
  assert.equal(rc.chain.height, 1)
  assert.notEqual(ra.chain.head!.hash, rc.chain.head!.hash)

  // восстанавливаем связь: ra подключается к rc
  ra.gossip.connect("rc")
  rc.gossip.connect("ra")
  flushBus(bus)
  await waitForHeight(() => ra.chain.height, rc.chain.height, { timeoutMs: NETWORK_TIMEOUT, label: "ra catchup" })

  flushBus(bus)
  await waitForHeight(() => rb.chain.height, rc.chain.height, { timeoutMs: NETWORK_TIMEOUT * 2, label: "rb catchup" })

  assert.equal(ra.chain.height, rb.chain.height)
  assert.equal(rb.chain.height, rc.chain.height)
})

test("e2e: fee market приоритизирует транзакции с высокой комиссией", async () => {
  const { nodes } = await setupNetwork(NODE_COUNT)
  const [a, b, c] = nodes
  const recipient = createWallet().address

  // добавляем транзакции с возрастающими nonce и разными fee
  const txLow = buildTx(a.wallet, recipient, 10n, { nonce: 0, fee: TX_FEE })
  const txMid = buildTx(a.wallet, recipient, 10n, { nonce: 1, fee: TX_FEE * 3n })
  const txHigh = buildTx(a.wallet, recipient, 10n, { nonce: 2, fee: TX_FEE * 5n })
  a.chain.mempool.add(txLow)
  a.chain.mempool.add(txMid)
  a.chain.mempool.add(txHigh)

  // пул должен отсортирован по fee (DESC)
  const sorted = a.chain.mempool.txs
  assert.equal(sorted[0].fee, TX_FEE * 5n)
  assert.equal(sorted[1].fee, TX_FEE * 3n)
  assert.equal(sorted[2].fee, TX_FEE)

  // майним блок и проверяем, что все 3 tx попали
  const block = a.chain.propose(sorted, a.wallet.privateKey, a.wallet.publicKey, a.chain.blocks.length)
  a.chain.accept(block)
  a.gossip.broadcastBlock(block)

  await waitForHeight(() => b.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "b sync" })
  await waitForHeight(() => c.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "c sync" })

  assert.equal(b.chain.height, 1)
  assert.equal(c.chain.height, 1)
  assert.equal(b.chain.head!.header.txCount, 3)
})

test("e2e: валидатор со стейком участвует в консенсусе", async () => {
  const { nodes } = await setupNetwork(NODE_COUNT)
  const [a, b, c] = nodes

  assertValidatorStaked(a.chain, a.wallet.publicKey)
  assertValidatorStaked(b.chain, b.wallet.publicKey)
  assertValidatorStaked(c.chain, c.wallet.publicKey)

  // a майнит блок
  const tx = buildTx(a.wallet, createWallet().address, 1n, { nonce: 0 })
  a.chain.mempool.add(tx)
  const block = a.chain.propose(a.chain.mempool.take(100), a.wallet.privateKey, a.wallet.publicKey, a.chain.blocks.length)
  a.chain.accept(block)
  a.gossip.broadcastBlock(block)

  await waitForHeight(() => b.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "b sync" })
  await waitForHeight(() => c.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "c sync" })

  assert.equal(b.chain.head!.hash, a.chain.head!.hash)
  assert.equal(c.chain.head!.hash, a.chain.head!.hash)
  assert.equal(a.chain.head!.header.proposer, a.wallet.publicKey)
})

test("e2e: все сообщения в сети доставляются", async () => {
  const { bus, nodes } = await setupNetwork(NODE_COUNT)
  const [ma, , mc] = nodes

  const tx = buildTx(ma.wallet, createWallet().address, 1n, { nonce: 0 })
  ma.chain.mempool.add(tx)
  const block = ma.chain.propose(ma.chain.mempool.take(100), ma.wallet.privateKey, ma.wallet.publicKey, ma.chain.blocks.length)
  ma.chain.accept(block)
  ma.gossip.broadcastBlock(block)
  flushBus(bus)

  await waitForHeight(() => ma.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "ma height" })
  await waitForHeight(() => mc.chain.height, 1, { timeoutMs: NETWORK_TIMEOUT, label: "mc height" })

  const delivered = countMessages(bus)
  assert.ok(delivered > 0, "в сети должны быть доставлены сообщения")
  assert.equal(ma.chain.head!.hash, block.hash)
  assert.equal(mc.chain.head!.hash, block.hash)
})
