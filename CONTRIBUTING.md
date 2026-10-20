# Contributing to Lumen

Lumen is small on purpose. It should be auditable in an afternoon.

## Ground rules

- plain TypeScript, ESM, no build step
- `core/crypto.ts` and `core/ledger.ts` are consensus-critical: changes need two reviewers
- every behaviour change comes with a test
- never commit keys, mnemonics or endpoints with credentials

## Setup

```bash
npm install
npm test
```

## Where things live

| Area | File | Note |
|---|---|---|
| Accounts, tx, staking, AMM | `core/ledger.ts` | consensus-critical |
| Blocks, consensus, mempool | `core/chain.ts` | consensus-critical |
| Keys, addresses, signing | `core/crypto.ts` | consensus-critical |
| JSON-RPC, wallet helpers | `core/rpc.ts` | |
| CLI | `cli/lumen.ts` | |
| Cross-asset converter | `keeper/keeper.ts` | |

## Bounties

Issues labelled 💰 Reward can be funded by anyone with `/reward <amount>` (Opire)
or via Algora. The reward is paid to whoever's PR gets merged — not to the repo
owner. That is the point: it buys contributors, reviewers and attention.

Acceptance criteria must be checkable. A PR that does not satisfy them does not
get the reward, however good it looks.
