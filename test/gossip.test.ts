import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { MIN_STAKE } from "../core/ledger.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { sha256, publicKeyBytes } from "../core/crypto.js"
import {
  GossipNode,
  MemoryNetwork,
  nullTransport,
  encodeBlock,
  decodeBlock,
  peerId,
} from "../core/gossip.js"

type Wallet = ReturnType<typeof createWallet>

/** Группа узлов с общим набором валидаторов — как в настоящей сети. */
function makeNetwork(size: number): { net: MemoryNetwork; nodes: GossipNode[]; wallets: Wallet[] } {
  const net = new MemoryNetwork()
  const wallets: Wallet[] = []
  for (let i = 0; i < size; i++) wallets.push(createWallet())
  const nodes = wallets.map((w) => {
    const chain = new Chain()
    chain.genesis()
    // весь набор валидаторов известен каждому узлу — иначе gossip-блок не проходит accept()
    for (const v of wallets) {
      chain.ledger.get(v.address).balance = 1_000_000_000_000n
      chain.ledger.get(v.address).publicKey = v.publicKey
      chain.addValidator(v.publicKey, MIN_STAKE * 10n)
    }
    return net.node(chain, w.publicKey)
  })
  return { net, nodes, wallets }
}

/** Предложить и принять блок: продюсер — владелец кошелька узла. */
function mine(node: GossipNode, wallet: Wallet, amount = 1000n): void {
  const chain = node.chain
  const dest = createWallet().address
  const nonce = chain.ledger.get(wallet.address).nonce
  const tx = buildTx(wallet, dest, amount, { nonce })
  node.accept(chain.propose([tx], wallet.privateKey, wallet.publicKey, chain.height + 1))
}

test("peerId — хэш публичного ключа", () => {
  const w = createWallet()
  assert.equal(peerId(w.publicKey), sha256(publicKeyBytes(w.publicKey)))
  assert.match(peerId(w.publicKey), /^[0-9a-f]{64}$/)
  // другой ключ — другой peerId
  assert.notEqual(peerId(w.publicKey), peerId(createWallet().publicKey))
})

test("два узла находят друг друга и после обмена имеют одинаковый stateRoot", () => {
  const { nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes

  // объявление: каждый видит peerId другого
  a.announce()
  b.announce()
  assert.ok(a.findPeers().some((p) => p.peerId === b.peerId), "a должен знать соседа b")
  assert.ok(b.findPeers().some((p) => p.peerId === a.peerId), "b должен знать соседа a")

  // блок рассылается соседям сразу после accept()
  mine(a, wallets[0], 1000n)
  assert.equal(a.chain.height, 1)
  assert.equal(b.chain.height, 1, "b принял блок по gossip")

  // главный критерий задачи: после обмена у обоих одинаковый stateRoot
  assert.equal(a.chain.ledger.stateRoot(), b.chain.ledger.stateRoot())
  assert.equal(a.chain.head!.hash, b.chain.head!.hash)
})

test("gossip не обходит consensus: продюсер не из набора валидаторов отвергается", () => {
  const { nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes
  a.announce()
  b.announce()

  // подпись валидна, но продюсер не валидатор — chain.accept обязан отвергнуть
  const stranger = createWallet()
  const block = a.chain.propose([], stranger.privateKey, stranger.publicKey, 1)
  b.ingest(encodeBlock(block), a.peerId)
  assert.equal(b.chain.height, 0, "высота не изменилась")
  assert.equal(b.stats.blocksAccepted, 0)
  assert.match(b.lastError!, /unknown proposer/)
  assert.ok(wallets.every((w) => !block.header.proposer.includes(w.publicKey)))
})

test("испорченный merkle root отвергается, узел продолжает работать", () => {
  const { nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes
  a.announce()
  b.announce()

  // b отстаёт на один блок, чтобы принять вредоносный блок.
  // Подпись перестаёт совпадать, как только меняется merkleRoot, и именно она
  // проверяется первой — это ожидаемый отказ, а не обход consensus.
  const wire = encodeBlock(a.chain.propose([], wallets[0].privateKey, wallets[0].publicKey, 1))
  wire.header = { ...wire.header, merkleRoot: "0".repeat(64) }
  b.ingest(wire, a.peerId)
  assert.equal(b.chain.height, 0, "невалидный блок не применён")
  assert.equal(b.stats.blocksRejected, 1)
  assert.match(b.lastError!, /bad block signature|bad merkle root/)

  // после отказа узел принимает корректный блок
  mine(a, wallets[0])
  assert.equal(b.chain.height, 1, "узел не сломан отказом")
})

test("подпись и merkle проверяются при переигровке догоняющей цепочки", () => {
  const { net, nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes
  net.disconnect(b)
  a.announce()
  mine(a, wallets[0])
  const good = a.chain.head!
  // b отстал на один блок; переигровка получает испорченный блок — replay обязан остановиться
  const wire = encodeBlock(good)
  wire.header = { ...wire.header, merkleRoot: "0".repeat(64) }
  b.handle(a.peerId, { kind: "blocks", blocks: [wire] })
  assert.equal(b.chain.height, 0, "испорченный блок не применён при переигровке")
})

test("узел догоняет более длинную цепочку переигровкой через chain.accept", () => {
  const { net, nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes

  // b офлайн, пока a догоняет сеть на три блока
  net.disconnect(b)
  a.announce()
  mine(a, wallets[0], 1000n)
  mine(a, wallets[0], 2000n)
  mine(a, wallets[0], 3000n)
  assert.equal(a.chain.height, 3)
  assert.equal(b.chain.height, 0, "офлайн-узел ничего не получил")

  // b возвращается: announce от a инициирует догоняние через wantBlocks
  net.reconnect(b)
  a.announce()
  assert.equal(b.chain.height, 3, "b догнал цепочку")
  assert.equal(a.chain.ledger.stateRoot(), b.chain.ledger.stateRoot())
  assert.ok(b.stats.catchUps >= 1, "догоняние зафиксировано в статистике")
})

test("повторная доставка блока не меняет состояние", () => {
  const { nodes, wallets } = makeNetwork(2)
  const [a, b] = nodes
  a.announce()
  b.announce()
  mine(a, wallets[0])
  assert.equal(b.chain.height, 1)

  const wire = encodeBlock(a.chain.head!)
  b.ingest(wire, a.peerId)
  b.ingest(wire, a.peerId)
  assert.equal(b.chain.height, 1, "высота не выросла при дублях")
})

test("испорченное сообщение от соседа не роняет узел", () => {
  const { nodes } = makeNetwork(2)
  const [a, b] = nodes
  a.announce()

  // amount не строка — кодек обязан отвергнуть, а не уронить процесс
  b.ingest(
    {
      header: { height: 1, prevHash: "x", timestamp: 0, proposer: "p", merkleRoot: "m", txCount: 1, slot: 1 },
      txs: [{ from: "f", to: "t", amount: 123 as unknown as string, fee: "1000", nonce: 0, timestamp: 0, signature: "s" }],
      signature: "s",
      hash: "h",
    },
    a.peerId,
  )
  assert.equal(b.chain.height, 0)
  assert.equal(b.stats.blocksRejected, 1)

  // то же самое на пути переигровки
  b.handle(a.peerId, {
    kind: "blocks",
    blocks: [
      {
        header: { height: 1, prevHash: "x", timestamp: 0, proposer: "p", merkleRoot: "m", txCount: 1, slot: 1 },
        txs: [{ from: "f", to: "t", amount: 123 as unknown as string, fee: "1000", nonce: 0, timestamp: 0, signature: "s" }],
        signature: "s",
        hash: "h",
      },
    ],
  })
  assert.equal(b.chain.height, 0, "узел жив после битого сообщения")
})

test("сосед с чужим генезисом не принимается", () => {
  const { nodes } = makeNetwork(2)
  const [a, b] = nodes

  // emulate узла из другой сети: объявляем заведомо чужой генезис
  b.handle(a.peerId, { kind: "announce", peerId: a.peerId, height: 0, genesisHash: "0".repeat(64) })
  assert.equal(b.findPeers().length, 0, "узел из другой сети не стал соседом")
  assert.equal(b.stats.rejectedPeers, 1)
})

test("три узла: gossip распространяет блок по всей сети", () => {
  const { nodes, wallets } = makeNetwork(3)
  const [a, b, c] = nodes
  for (const n of nodes) n.announce()

  mine(a, wallets[0])
  assert.equal(a.chain.height, 1)
  assert.equal(b.chain.height, 1)
  assert.equal(c.chain.height, 1)
  assert.equal(a.chain.ledger.stateRoot(), c.chain.ledger.stateRoot())
})

test("блок от любого валидатора расходится по сети", () => {
  const { nodes, wallets } = makeNetwork(3)
  const [, b, c] = nodes
  for (const n of nodes) n.announce()

  mine(b, wallets[1], 5000n)
  assert.equal(b.chain.height, 1)
  assert.equal(c.chain.height, 1, "узел без связи с продюсером тоже получил блок")
  assert.equal(b.chain.ledger.stateRoot(), c.chain.ledger.stateRoot())
})

test("проводный кодек сохраняет bigint без потерь", () => {
  const { nodes, wallets } = makeNetwork(1)
  const [a] = nodes
  mine(a, wallets[0], 123_456_789n)
  const decoded = decodeBlock(encodeBlock(a.chain.head!))
  assert.equal(decoded.header.merkleRoot, a.chain.head!.header.merkleRoot)
  assert.equal(decoded.txs[0].amount, 123_456_789n)
  assert.equal(decoded.hash, a.chain.head!.hash)
})

test("gossip работает без сети: nullTransport ничего не рассылает", () => {
  const w = createWallet()
  const chain = new Chain()
  chain.genesis()
  chain.ledger.get(w.address).balance = 1_000_000_000_000n
  chain.ledger.get(w.address).publicKey = w.publicKey
  chain.addValidator(w.publicKey, MIN_STAKE)
  const node = new GossipNode(chain, { publicKey: w.publicKey, transport: nullTransport })
  mine(node, w)
  assert.equal(chain.height, 1)
  assert.equal(node.findPeers().length, 0, "nullTransport ничего не доставляет")
})