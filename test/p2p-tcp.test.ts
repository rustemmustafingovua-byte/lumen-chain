import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { Gossip, createTcpTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"

/** Два настоящих узла общаются по TCP на localhost. */
test("p2p: два узла обмениваются блоком по TCP", async () => {
  const validators = [createWallet(), createWallet()]
  const makeChain = () => {
    const chain = new Chain()
    chain.genesis()
    for (const v of validators) {
      chain.ledger.get(v.address).balance = 1_000_000_000_000n
      chain.ledger.get(v.address).publicKey = v.publicKey
      chain.addValidator(v.publicKey, MIN_STAKE * 10n)
    }
    return chain
  }

  const chainA = makeChain()
  const chainB = makeChain()
  const transportA = createTcpTransport({ port: 0 })
  const transportB = createTcpTransport({ port: 0 })
  const portB = await transportB.whenListening()

  const gossipA = new Gossip(chainA, {
    peerId: peerIdFromPublicKey(validators[0].publicKey),
    pubkey: validators[0].publicKey,
    transport: transportA,
  })
  const gossipB = new Gossip(chainB, {
    peerId: peerIdFromPublicKey(validators[1].publicKey),
    pubkey: validators[1].publicKey,
    transport: transportB,
  })
  gossipA.start()
  gossipB.start()

  gossipA.connect(`127.0.0.1:${portB}`)
  await new Promise((r) => setTimeout(r, 300))

  const tx = buildTx(validators[1], createWallet().address, 5n, { nonce: 0 })
  const block = chainB.propose([tx], validators[1].privateKey, validators[1].publicKey, 1)
  chainB.accept(block)
  gossipB.broadcastBlock(block)

  const deadline = Date.now() + 5000
  while (chainA.height < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(chainA.height, 1, "блок должен прийти по TCP")
  assert.equal(chainA.head!.hash, block.hash)

  gossipA.stop()
  gossipB.stop()
  transportA.close()
  transportB.close()
})
