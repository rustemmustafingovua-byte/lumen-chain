/**
 * Lumen — gossip-слой: узлы находят друг друга по peerId и расходятся блоками.
 *
 * Слой ничего не знает о сети: транспорт — это два метода (`send` и `broadcast`),
 * поэтому один и тот же gossip работает в тестах (in-memory) и поверх node:net.
 *
 * Принятый из сети блок проходит ровно ту же проверку `chain.accept()`, что и
 * локально предложенный: высота, prevHash, подпись продюсера, хэш, Merkle-корень.
 *
 * Consensus-critical код (`core/ledger.ts`, `core/crypto.ts`) этот слой не трогает.
 * Единственное изменение в `core/chain.ts` — фиксированное время генезис-блока
 * (`GENESIS_TIMESTAMP`): без него у каждого узла был свой генезис, и блок,
 * предложенный соседом, не проходил проверку `prevHash`. Сама проверка
 * не менялась.
 */
import { sha256, publicKeyBytes } from "./crypto.js"
import type { Block, Chain } from "./chain.js"
import type { Tx } from "./ledger.js"

/** Сколько хэшей блоков помнить, чтобы не ретранслить один и тот же блок по кругу. */
export const DEFAULT_SEEN_LIMIT = 512

/** Идентификатор узла: хэш публичного ключа. */
export function peerId(publicKeyB64: string): string {
  return sha256(publicKeyBytes(publicKeyB64))
}

export type PeerInfo = {
  peerId: string
  /** последняя известная высота цепочки соседа */
  height: number
  /** локальное время последнего контакта */
  lastSeen: number
}

/** Транзакция в проводном виде: bigint уходит строкой. */
export type WireTx = Omit<Tx, "amount" | "fee"> & { amount: string; fee: string }
/** Блок в проводном виде. */
export type WireBlock = Omit<Block, "txs"> & { txs: WireTx[] }

export type GossipMessage =
  | { kind: "announce"; peerId: string; height: number; genesisHash: string }
  | { kind: "peers"; peers: PeerInfo[] }
  | { kind: "block"; block: WireBlock }
  | { kind: "wantBlocks"; from: number; to: number }
  | { kind: "blocks"; blocks: WireBlock[] }

/** Транспорт: куда узел отправляет сообщения. Реализуется на node:net, WebSocket и т.п. */
export type Transport = {
  send(to: string, msg: GossipMessage): void
  broadcast(except: string, msg: GossipMessage): void
}

export function encodeBlock(b: Block): WireBlock {
  return {
    ...b,
    txs: b.txs.map((t) => ({ ...t, amount: t.amount.toString(), fee: t.fee.toString() })),
  }
}

export function decodeBlock(w: WireBlock): Block {
  return {
    ...w,
    txs: w.txs.map((t) => ({ ...t, amount: BigInt(t.amount), fee: BigInt(t.fee) })),
  }
}

export class GossipError extends Error {}

/**
 * Узел gossip-сети поверх существующего `Chain`.
 *
 * Жизненный цикл: `announce()` → обмен соседями → `accept()`/`ingest()` →
 * рассылка соседям → при необходимости догоняет более длинную цепочку.
 */
export class GossipNode {
  readonly peerId: string
  readonly publicKey: string
  transport: Transport
  /** известные соседи: peerId → последняя высота и время контакта */
  peers = new Map<string, PeerInfo>()
  /** хэши уже обработанных блоков — защита от повторов и петель ретрансляции */
  seen = new Set<string>()
  stats = { blocksAccepted: 0, blocksRelayed: 0, blocksRejected: 0, catchUps: 0, rejectedPeers: 0 }
  /** текст последней отвергнутой проверки — для диагностики без стектрейса */
  lastError?: string
  private seenLimit: number

  constructor(
    readonly chain: Chain,
    opts: { publicKey: string; transport: Transport; seenLimit?: number },
  ) {
    this.publicKey = opts.publicKey
    this.peerId = peerId(opts.publicKey)
    this.transport = opts.transport
    this.seenLimit = opts.seenLimit ?? DEFAULT_SEEN_LIMIT
  }

  /** Соседи, отсортированные по peerId — порядок не зависит от порядка прихода. */
  findPeers(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => (a.peerId < b.peerId ? -1 : 1))
  }

  /** Объявить себя соседям: свой peerId, высота, хэш генезиса и список соседей. */
  announce() {
    this.transport.broadcast("", this.hello())
    this.transport.broadcast("", { kind: "peers", peers: this.findPeers() })
  }

  /** Сообщение о себе: кто я, какой у меня генезис и на какой высоте я стою. */
  hello(): GossipMessage {
    return {
      kind: "announce",
      peerId: this.peerId,
      height: this.chain.height,
      genesisHash: this.chain.blocks[0]?.hash ?? "",
    }
  }

  /** Принять локально предложенный блок и сразу разослать его соседям. */
  accept(block: Block): boolean {
    const ok = this.chain.accept(block)
    this.markSeen(block.hash)
    this.stats.blocksAccepted += 1
    this.relay(block, "")
    return ok
  }

  /** Обработать входящее сообщение от соседа `from`. */
  handle(from: string, msg: GossipMessage) {
    if (from === this.peerId) return // собственный эхо-трафик
    this.touch(from)
    switch (msg.kind) {
      case "announce":
        this.handleAnnounce(from, msg)
        return
      case "peers":
        for (const p of msg.peers) {
          if (p.peerId === this.peerId) continue
          const known = this.peers.get(p.peerId)
          if (!known || p.height > known.height)
            this.peers.set(p.peerId, { peerId: p.peerId, height: p.height, lastSeen: Date.now() })
        }
        return
      case "block":
        this.ingest(msg.block, from)
        return
      case "wantBlocks":
        this.sendBlocks(from, msg.from, msg.to)
        return
      case "blocks":
        this.replay(msg.blocks, from)
        return
    }
  }

  /** Принять блок, пришедший по gossip, или запросить недостающие. */
  ingest(wire: WireBlock, from: string) {
    let block: Block
    try {
      block = decodeBlock(wire)
    } catch {
      this.stats.blocksRejected += 1
      return
    }
    // уже есть — ретрансляцию этого хэша делал отправитель
    if (block.header.height <= this.chain.height || this.seen.has(block.hash)) return

    if (block.header.height === this.chain.height + 1) {
      this.tryAccept(block)
      return
    }
    // увидели более длинную цепочку — догоняем её переигровкой через chain.accept
    this.catchUp(from, block.header.height)
  }

  /**
   * Принять блок, не давая одному плохому соседу обрушить узел: ошибка
   * проверок ловится здесь, вызывающий код (рассылка) не падает.
   */
  private tryAccept(block: Block): boolean {
    try {
      return this.accept(block)
    } catch (e) {
      this.stats.blocksRejected += 1
      this.lastError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /** Запросить у соседа блоки [from..to] и переиграть их. */
  private catchUp(from: string, to: number) {
    const want: GossipMessage = { kind: "wantBlocks", from: this.chain.height + 1, to }
    this.transport.send(from, want)
    this.stats.catchUps += 1
  }

  /** Отдать соседу недостающие блоки из своего локального хранилища. */
  private sendBlocks(to: string, from: number, to2: number) {
    const lo = Math.max(0, from)
    const hi = Math.min(to2, this.chain.blocks.length - 1)
    if (hi < lo) return
    this.transport.send(to, { kind: "blocks", blocks: this.chain.blocks.slice(lo, hi + 1).map(encodeBlock) })
  }

  /** Переиграть полученные блоки по порядку — тем же путём, что и локальный блок. */
  private replay(wires: WireBlock[], from: string) {
    const ordered = [...wires].sort((a, b) => a.header.height - b.header.height)
    for (const wire of ordered) {
      let block: Block
      try {
        block = decodeBlock(wire)
      } catch {
        this.stats.blocksRejected += 1
        return
      }
      if (block.header.height !== this.chain.height + 1) continue // разрыв или дубль
      if (!this.tryAccept(block)) return // невалидный блок разрывает цепочку
    }
    // соседи, у которых мы отстали, получат наши актуальные блоки
    this.transport.send(from, this.hello())
  }

  private handleAnnounce(from: string, msg: Extract<GossipMessage, { kind: "announce" }>) {
    // разные сети не gossip-ятся между собой: генезис должен совпадать
    if (msg.genesisHash !== this.genesisHash()) {
      this.stats.rejectedPeers += 1
      return
    }
    const known = this.peers.get(from)
    this.peers.set(from, { peerId: from, height: msg.height, lastSeen: Date.now() })
    if (!known) this.announce() // новый сосед — отвечаем взаимностью
    if (msg.height > this.chain.height) this.catchUp(from, msg.height)
  }

  /** Хэш генезис-блока: идентичность сети. */
  genesisHash(): string {
    return this.chain.blocks[0]?.hash ?? ""
  }

  private touch(peer: string) {
    const known = this.peers.get(peer)
    if (known) known.lastSeen = Date.now()
  }

  private relay(block: Block, except: string) {
    this.transport.broadcast(except, { kind: "block", block: encodeBlock(block) })
    this.stats.blocksRelayed += 1
  }

  private markSeen(hash: string) {
    this.seen.add(hash)
    while (this.seen.size > this.seenLimit) {
      const oldest = this.seen.values().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }
}

/** Транспорт без выхода в сеть: для тестов и для одиночного узла. */
export const nullTransport: Transport = {
  send() {},
  broadcast() {},
}

/**
 * In-memory сеть для тестов: `net.node()` создаёт узел, `net.disconnect()`
 * рвёт связь, `net.reconnect()` возвращает её — так проверяется догоняние
 * цепочки, накопленной пока узел был офлайн.
 */
export class MemoryNetwork {
  private handlers = new Map<string, (from: string, msg: GossipMessage) => void>()
  private online = new Set<string>()
  /** доставлено сообщений — удобно проверять в тестах */
  delivered = 0

  node(chain: Chain, publicKey: string): GossipNode {
    const n = new GossipNode(chain, { publicKey, transport: this.transportFor(peerId(publicKey)) })
    this.handlers.set(n.peerId, (from, msg) => n.handle(from, msg))
    this.online.add(n.peerId)
    return n
  }

  disconnect(n: GossipNode) {
    this.online.delete(n.peerId)
  }

  reconnect(n: GossipNode) {
    this.online.add(n.peerId)
  }

  connected(n: GossipNode): boolean {
    return this.online.has(n.peerId)
  }

  /** Доставить сообщение напрямую — для проверки идемпотентности. */
  deliver(from: string, to: string, msg: GossipMessage) {
    if (!this.online.has(to)) return
    const h = this.handlers.get(to)
    if (!h) return
    this.delivered += 1
    h(from, msg)
  }

  private transportFor(self: string): Transport {
    return {
      send: (to, msg) => this.deliver(self, to, msg),
      broadcast: (except, msg) => {
        for (const peer of [...this.handlers.keys()]) {
          if (peer === self || peer === except) continue
          this.deliver(self, peer, msg)
        }
      },
    }
  }
}