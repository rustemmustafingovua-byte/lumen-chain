# Lumen v0.1.0 — launch

**A proof-of-stake chain that ships with its own market.** Stake it, swap anything
into it, and leave — without ever opening an exchange account.

- repo: https://github.com/rustemmustafingovua-byte/lumen-chain
- docs: https://rustemmustafingovua-byte.github.io/lumen-chain/
- release: https://github.com/rustemmustafingovua-byte/lumen-chain/releases/tag/v0.1.0
- package: `@rustemmustafingovua-byte/lumen-chain` (GitHub Packages) · tarball: `lumen-chain-0.1.0.tgz`
- donation: USDC on Base → `0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E`

## Why this exists

Every crypto project assumes that an exchange will list its token and that its
users will tolerate one. Lumen removes both assumptions:

1. **The market is part of the protocol.** The AMM lives in the chain, so
   LMN/USDC liquidity exists from block one — no listing, no CEX listing fee,
   no frozen withdrawals.
2. **The keeper is the exchange.** A daemon watches the treasury and converts
   whatever arrives (USDC, ETH) into LMN on its own, and sells LMN back when you
   want out. You never sign up for anything.
3. **The chain is yours.** MIT, no VC, no foundation above you. A validator set
   you control and a ledger you can read line by line.

## What is in the box

| | |
|---|---|
| `core/` | ed25519 accounts, PoS consensus, Merkle blocks, pool, AMM, JSON-RPC |
| `cli/` | `lumen` — wallet, node, transfers, staking, swaps, explorer |
| `keeper/` | the autonomous converter: any asset → LMN, and back |
| `contracts/` | LMN as an ERC-20 on Base + the on-chain AMM |
| `docs/` | architecture, tokenomics, funding model, threat model |

## Numbers

- supply: 1,000,000,000 LMN, fixed, no mint after genesis
- emission: 3% per year to validators, halving every 4 years
- minimum stake: 10,000 LMN
- transaction fee: 0.001 LMN
- AMM fee: 0.30% to liquidity providers
- genesis: 60% treasury, 40% early-validator pool (paid 1:1 to whoever stakes first)

## Try it in two minutes

```bash
npm i -g https://github.com/rustemmustafingovua-byte/lumen-chain/releases/download/v0.1.0/lumen-chain-0.1.0.tgz
lumen wallet new
lumen node
lumen explorer
```

```bash
git clone https://github.com/rustemmustafingovua-byte/lumen-chain
cd lumen-chain && npm install && npm test   # 11 tests
```

## Where it goes next

- **v0.2** — P2P gossip layer (nodes that actually see each other), LP shares in
  the AMM, a smart-contract VM inside the chain, an explorer.
- **v0.3** — Base ↔ Lumen bridge with verification on the Lumen side, HTLC swaps,
  hardware-wallet support, an audit.

## Get involved

Issues labelled 💰 Reward are funded by whoever comments `/reward <amount>` on
them — the payout goes to whoever's PR gets merged, not to the repo owner. Start
with the "good first issue" (AMM edge-case tests) or the audit issue.

If you want to support the work: USDC on Base, or sponsor on GitHub.

MIT © rustemmustafingovua-byte
