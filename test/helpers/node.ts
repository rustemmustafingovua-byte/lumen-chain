/**
 * Создаёт узел Lumen с памятью (Chain + Gossip) для тестов.
 */
import { Chain } from "../../core/chain.js"
import { Gossip, createMemoryBus, createMemoryTransport, peerIdFromPublicKey } from "../../core/p2p.js"
import { MIN_STAKE, TX_FEE } from "../../core/ledger.js"
import { createWallet, buildTx, type Wallet } from "../../core/rpc.js"
import type { Block } from "../../core/chain.js"

export interface NodeContext {
  chain: Chain
  wallet: Wallet
  gossip: Gossip
  transport: ReturnType<typeof createMemoryTransport>
  bus: ReturnType<typeof createMemoryBus>
  addr: string
}

export interface NetworkConfig {
  nodeCount: number
  slotMs?: number
  autoMine?: boolean
  mineIntervalMs?: number
}

export function createNode(bus: ReturnType<typeof createMemoryBus>, addr: string): NodeContext {
  const chain = new Chain()
  chain.genesis()
  const wallet = createWallet()
  const transport = createMemoryTransport(bus)

  const gossip = new Gossip(chain, {
    peerId: peerIdFromPublicKey(wallet.publicKey),
    pubkey: wallet.publicKey,
    transport,
    log: (_msg: string) => {},
  })
  gossip.start()
  transport.__setAddr(addr)
  ;(bus as any).register(addr, transport)

  chain.ledger.get(wallet.address).balance = 1_000_000_000_000n
  chain.ledger.get(wallet.address).publicKey = wallet.publicKey
  chain.addValidator(wallet.publicKey, MIN_STAKE * 10n)

  return { chain, wallet, gossip, transport, bus, addr }
}

/** Подготовить сеть: создать N узлов, зарегистрировать всех валидаторов в каждом. */
export function makeNetwork(count: number) {
  const bus = createMemoryBus()
  const validators = Array.from({ length: count }, () => createWallet())
  const nodes = validators.map((v, i) => {
    const chain = new Chain()
    chain.genesis()
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
      log: (_msg: string) => {},
    })
    gossip.start()
    transport.__setAddr(String.fromCharCode(97 + i))
    ;(bus as any).register(String.fromCharCode(97 + i), transport)
    return { chain, w: v, transport, gossip }
  })
  return { nodes, validators, bus }
}

export function connectPeers(node: NodeContext, peers: { addr: string }[]): void {
  for (const p of peers) {
    node.gossip.connect(p.addr)
  }
}

export function fundNode(chain: Chain, wallet: Wallet, amount: bigint = 1_000_000_000_000n): void {
  chain.ledger.get(wallet.address).balance += amount
  chain.ledger.get(wallet.address).publicKey = wallet.publicKey
}

export function sendTx(
  from: Wallet,
  to: string,
  amount: bigint,
  chain: Chain,
  opts: { nonce?: number; data?: string } = {},
): Block | null {
  const tx = buildTx(from, to, amount, {
    nonce: opts.nonce ?? chain.ledger.get(from.address).nonce,
    data: opts.data,
  })
  chain.mempool.add(tx)
  const txs = chain.mempool.take(100)
  if (txs.length === 0) return null
  const slot = chain.blocks.length
  const block = chain.propose(txs, from.privateKey, from.publicKey, slot)
  chain.accept(block)
  chain.rewardProposer(from.publicKey)
  return block
}

export function countMessages(bus: ReturnType<typeof createMemoryBus>): number {
  return bus.delivered
}
