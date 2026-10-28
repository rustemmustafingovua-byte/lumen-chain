/**
 * Lumen — P2P-слой: gossip и синхронизация.
 *
 * Узлы обмениваются тремя сообщениями:
 *   hello      — представление: кто я, на какой высоте
 *   block      — новый блок (реbroadcast после принятия)
 *   getBlocks  — прошу недостающие блоки
 *   blocks     — ответ на getBlocks
 *
 * Транспорт абстрагирован, чтобы сеть можно было тестировать без сокетов:
 *   createTcpTransport()     — реальный TCP (newline-delimited JSON)
 *   createMemoryTransport()  — для тестов и симуляций
 */
import { createServer, connect as netConnect, type Server, type Socket } from "node:net"
import { Chain, type Block } from "./chain.js"
import { type Tx } from "./ledger.js"
import { sha256 } from "./crypto.js"

export type PeerId = string

export type WireTx = Omit<Tx, "amount" | "fee"> & { amount: string; fee: string }

export type WireBlock = {
  header: Block["header"]
  txs: WireTx[]
  signature: string
  hash: string
}

export type Message =
  | { type: "hello"; peerId: PeerId; height: number; pubkey: string }
  | { type: "block"; block: WireBlock }
  | { type: "getBlocks"; from: number; count: number }
  | { type: "blocks"; blocks: WireBlock[] }

export interface Transport {
  /** Отправить сообщение узлу (адрес или id — как умеет транспорт). */
  send(to: string, data: string): void
  /** Подписаться на входящие сообщения. Возвращает функцию отписки. */
  onMessage(cb: (from: string, data: string) => void): () => void
  /** Подключиться к узлу (для TCP). */
  connect?(addr: string): void
  close(): void
}

export function peerIdFromPublicKey(pubkey: string): PeerId {
  return sha256(pubkey).slice(0, 32)
}

export function toWireBlock(b: Block): WireBlock {
  return {
    header: b.header,
    txs: b.txs.map((t) => ({ ...t, amount: t.amount.toString(), fee: t.fee.toString() })),
    signature: b.signature,
    hash: b.hash,
  }
}

export function fromWireBlock(w: WireBlock): Block {
  return {
    header: w.header,
    txs: w.txs.map((t) => ({ ...t, amount: BigInt(t.amount), fee: BigInt(t.fee) })),
    signature: w.signature,
    hash: w.hash,
  }
}

export type GossipOptions = {
  peerId: PeerId
  pubkey: string
  transport: Transport
  /** Сколько блоков запрашивать за раз при догонянии. */
  syncBatch?: number
  log?: (msg: string) => void
}

export class Gossip {
  readonly peerId: PeerId
  readonly pubkey: string
  readonly chain: Chain
  readonly transport: Transport
  /** известные узлы: адрес -> последняя высота */
  peers = new Map<string, number>()
  /** сколько раз блок уже пересылали (защита от лавины) */
  private seen = new Set<string>()
  private unsubscribe?: () => void
  private log: (msg: string) => void
  private syncBatch: number
  /** сколько узлов уже получили блок (для rebroadcast) */
  private relayed = new Map<string, Set<string>>()
  /** батч для исходящих сообщений */
  private outbox: { to: string; msg: Message }[] = []
  private outboxTimer: ReturnType<typeof setInterval> | undefined
  /** лимит исходящих соединений */
  private maxPeers = 50

  constructor(chain: Chain, opts: GossipOptions) {
    this.chain = chain
    this.peerId = opts.peerId
    this.pubkey = opts.pubkey
    this.transport = opts.transport
    this.syncBatch = opts.syncBatch ?? 64
    this.log = opts.log ?? (() => {})
  }

  start() {
    this.unsubscribe = this.transport.onMessage((from, data) => this.handle(from, data))
    this.sendHello()
    this.outboxTimer = setInterval(() => this.flushOutbox(), 50)
    this.log(`gossip: запущен, peerId=${this.peerId}`)
  }

  stop() {
    if (this.outboxTimer) clearInterval(this.outboxTimer)
    this.unsubscribe?.()
    this.transport.close()
  }

  setMaxPeers(n: number) {
    this.maxPeers = n
  }

  /** Обнаружение пиров: массовое подключение с ограничением. */
  discoverPeers(addrs: string[]) {
    let added = 0
    for (const addr of addrs) {
      if (this.peers.size >= this.maxPeers) break
      if (!this.peers.has(addr)) {
        this.connect(addr)
        added++
      }
    }
    return added
  }

  /** Подключиться к узлу и поздороваться. */
  connect(addr: string) {
    this.peers.set(addr, this.chain.height)
    this.transport.connect?.(addr)
    this.sendTo(addr, { type: "hello", peerId: this.peerId, height: this.chain.height, pubkey: this.pubkey })
  }

  private sendTo(to: string, msg: Message) {
    if (this.outboxTimer) {
      this.outbox.push({ to, msg })
    } else {
      this.transport.send(to, JSON.stringify(msg))
    }
  }

  private flushOutbox() {
    if (this.outbox.length === 0) return
    // группируем по получателю, чтобы не дублировать JSON.stringify
    const batches = new Map<string, string[]>()
    for (const { to, msg } of this.outbox) {
      const json = JSON.stringify(msg)
      const arr = batches.get(to) ?? []
      arr.push(json)
      batches.set(to, arr)
    }
    this.outbox = []
    for (const [to, jsons] of batches) {
      for (const json of jsons) {
        this.transport.send(to, json)
      }
    }
  }

  private sendHello() {
    const hello: Message = { type: "hello", peerId: this.peerId, height: this.chain.height, pubkey: this.pubkey }
    for (const addr of this.peers.keys()) this.sendTo(addr, hello)
    this.flushOutbox()
  }

  /** Разослать новый блок всем известным узлам. */
  broadcastBlock(block: Block) {
    const wire = toWireBlock(block)
    for (const addr of this.peers.keys()) {
      this.sendTo(addr, { type: "block", block: wire })
    }
    this.seen.add(block.hash)
    this.relayed.set(block.hash, new Set(this.peers.keys()))
    this.log(`gossip: блок #${block.header.height} рассылан (${this.peers.size} узлов)`)
    this.flushOutbox()
  }

  /** Разослать произвольное сообщение. */
  broadcast(msg: Message) {
    for (const addr of this.peers.keys()) this.sendTo(addr, msg)
    this.flushOutbox()
  }

  handle(from: string, raw: string) {
    let msg: Message
    try {
      msg = JSON.parse(raw) as Message
    } catch {
      return
    }
    switch (msg.type) {
      case "hello": {
        this.peers.set(from, msg.height)
        this.sendTo(from, { type: "hello", peerId: this.peerId, height: this.chain.height, pubkey: this.pubkey })
        if (msg.height > this.chain.height) {
          this.requestBlocks(from, this.chain.height + 1)
        }
        break
      }
      case "block": {
        this.acceptBlock(from, fromWireBlock(msg.block))
        break
      }
      case "getBlocks": {
        const blocks = this.chain.blocks
          .slice(Math.max(0, msg.from - 1), Math.max(0, msg.from - 1) + msg.count)
          .map(toWireBlock)
        this.sendTo(from, { type: "blocks", blocks })
        break
      }
      case "blocks": {
        for (const w of msg.blocks) this.acceptBlock(from, fromWireBlock(w))
        break
      }
    }
    this.flushOutbox()
  }

  /** Принять блок от соседа и переслать дальше (gossip). */
  private acceptBlock(from: string, block: Block) {
    if (this.seen.has(block.hash)) return
    if (block.header.height !== this.chain.height + 1) {
      // не наш следующий блок — возможно, мы отстали: просим недостающие
      if (block.header.height > this.chain.height + 1) {
        this.requestBlocks(from, this.chain.height + 1)
      }
      return
    }
    try {
      this.chain.accept(block)
    } catch (e) {
      this.log(`gossip: блок #${block.header.height} отклонён: ${(e as Error).message}`)
      return
    }
    this.seen.add(block.hash)
    this.log(`gossip: принят блок #${block.header.height} от ${from}`)
    // пересылаем дальше, но не тому, от кого получили
    const already = this.relayed.get(block.hash) ?? new Set<string>()
    for (const addr of this.peers.keys()) {
      if (addr === from) continue
      if (already.has(addr)) continue
      this.sendTo(addr, { type: "block", block: toWireBlock(block) })
      already.add(addr)
    }
    this.relayed.set(block.hash, already)
  }

  private requestBlocks(to: string, from: number) {
    this.sendTo(to, { type: "getBlocks", from, count: this.syncBatch })
  }
}

// --- транспорты -------------------------------------------------------------

/** TCP-транспорт: newline-delimited JSON поверх TCP. */
export function createTcpTransport(opts: { port?: number; host?: string } = {}): Transport & {
  port: number
  /** Порт, на котором сервер реально слушает (после 'listening'). */
  whenListening(): Promise<number>
} {
  const handlers: ((from: string, data: string) => void)[] = []
  const sockets = new Map<string, Socket>()
  let server: Server | undefined
  const port = opts.port ?? 0
  let actualPort = port
  let listening: Promise<number> | undefined

  const emit = (from: string, data: string) => {
    for (const h of handlers) h(from, data)
  }

  if (opts.port !== undefined || opts.host !== undefined) {
    server = createServer((socket) => {
      const id = `${socket.remoteAddress}:${socket.remotePort}`
      sockets.set(id, socket)
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString()
        let idx = buf.indexOf("\n")
        while (idx >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.trim()) emit(id, line)
          idx = buf.indexOf("\n")
        }
      })
      socket.on("close", () => sockets.delete(id))
      socket.on("error", () => sockets.delete(id))
    })
    listening = new Promise<number>((resolve) => {
      server!.once("listening", () => {
        const addr = server!.address()
        actualPort = typeof addr === "object" && addr ? addr.port : port
        resolve(actualPort)
      })
    })
    server.listen(opts.port ?? 0, opts.host ?? "0.0.0.0")
  }

  return {
    get port() {
      return actualPort
    },
    whenListening() {
      return listening ?? Promise.resolve(actualPort)
    },
    send(to, data) {
      const s = sockets.get(to)
      if (s && !s.destroyed) s.write(data + "\n")
    },
    onMessage(cb) {
      handlers.push(cb)
      return () => {
        const i = handlers.indexOf(cb)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
    connect(addr) {
      const [host, p] = addr.split(":")
      const socket = netConnect(Number(p ?? 0), host)
      const id = addr
      sockets.set(id, socket)
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString()
        let idx = buf.indexOf("\n")
        while (idx >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.trim()) emit(id, line)
          idx = buf.indexOf("\n")
        }
      })
      socket.on("close", () => sockets.delete(id))
      socket.on("error", () => sockets.delete(id))
    },
    close() {
      for (const s of sockets.values()) s.destroy()
      sockets.clear()
      server?.close()
    },
  }
}

/** Транспорт в памяти — для тестов и симуляций сети. */
export type MemoryBus = {
  /** Зарегистрировать узел под адресом (как в connect()). */
  register(addr: string, t: MemoryTransport): void
  /** Раздать накопленные сообщения по адресам. Возвращает число доставленных. */
  flush(): number
  /** Всего доставлено сообщений. */
  delivered: number
}

export type MemoryTransport = Transport & {
  /** Внутреннее: доставить сообщение обработчикам этого узла. */
  __deliver(m: { from: string; data: string }): void
  /** Внутреннее: узел зарегистрирован под адресом. */
  __setAddr(addr: string): void
}

/** Шина в памяти: маршрутизирует сообщения между виртуальными узлами. */
export function createMemoryBus(): MemoryBus {
  const inbox = new Map<string, { from: string; data: string }[]>()
  const registry = new Map<string, MemoryTransport>()

  const bus: MemoryBus = {
    delivered: 0,
    register(addr, t) {
      registry.set(addr, t)
      t.__setAddr(addr)
    },
    flush() {
      let n = 0
      for (const [addr, queue] of [...inbox.entries()]) {
        inbox.delete(addr)
        const target = registry.get(addr)
        if (!target) continue
        for (const m of queue) {
          target.__deliver(m)
          n++
        }
      }
      bus.delivered += n
      return n
    },
  }

  // внутренние методы шины, используются транспортом
  ;(bus as any).post = (from: string, to: string, data: string) => {
    const arr = inbox.get(to) ?? []
    arr.push({ from, data })
    inbox.set(to, arr)
  }
  return bus
}

/** Транспорт, работающий через шину в памяти. */
export function createMemoryTransport(bus: MemoryBus): MemoryTransport {
  const handlers: ((from: string, data: string) => void)[] = []
  let selfAddr = "?"
  const transport: MemoryTransport = {
    send(to, data) {
      ;(bus as any).post(selfAddr, to, data)
    },
    onMessage(cb) {
      handlers.push(cb)
      return () => {
        const i = handlers.indexOf(cb)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
    connect() {},
    close() {},
    __deliver(m) {
      for (const h of handlers) h(m.from, m.data)
    },
    __setAddr(addr) {
      selfAddr = addr
    },
  }
  return transport
}
