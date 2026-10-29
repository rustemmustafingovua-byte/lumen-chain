# Lumen Chain

Local proof-of-stake devnet with a built-in constant-product pool. You can run a node, stake LMN, and swap LMN for an internal USDC balance.

This repository does **not** run a public network. There is no mainnet, no bridge, and no real USDC. The devnet validator key is derived from a public seed (`lumen/devnet/validator/v1`). Do not send real funds to anything in this repo.

Amounts are base units. 1 LMN = 1,000,000 units. The minimum stake is 10,000 LMN (`10000000000`).

## Run a devnet

Docker Compose builds the node and starts it on this machine.

```bash
docker compose up --build
```

- Explorer and JSON-RPC: http://127.0.0.1:8899
- Health: http://127.0.0.1:8899/health
- Devnet account: http://127.0.0.1:8899/api/devnet/info
- P2P: `127.0.0.1:8789`
- Chain data: the `lumen-data` volume, mounted at `/data/.lumen` in the container

Wait until the health check is green (the first block is produced about 4 seconds after start), then stake and swap:

```bash
curl -s http://127.0.0.1:8899/api/devnet/info

# Stake another 10,000 LMN. The next block includes it.
curl -s -X POST http://127.0.0.1:8899/api/devnet/stake \
  -H 'content-type: application/json' \
  -d '{"amount":"10000000000"}'

# Sell 1 LMN into the LMN/USDC pool. USDC here is an internal balance.
curl -s -X POST http://127.0.0.1:8899/api/devnet/swap \
  -H 'content-type: application/json' \
  -d '{"direction":"sell","amount":"1000000"}'

# Buy LMN back with internal USDC.
curl -s -X POST http://127.0.0.1:8899/api/devnet/swap \
  -H 'content-type: application/json' \
  -d '{"direction":"buy","amount":"1000000"}'
```

`scripts/devnet-smoke.sh` performs the same health, stake, and swap checks.

```bash
bash scripts/devnet-smoke.sh
```

Stop and delete the chain data:

```bash
docker compose down -v
```

### Without Docker

Requires Node.js 22 or newer. `better-sqlite3` 13 does not run on Node 20.

```bash
npm ci
LUMEN_NETWORK=devnet LUMEN_HOME=./.lumen-devnet \
  npx tsx cli/lumen.ts serve --port=8899
```

The same HTTP calls work against `http://127.0.0.1:8899`.

## Tests

```bash
npm test
npm run build
```

`test/staking-swap.test.ts` covers genesis funding, staking into a block, both swap directions, rejection of a dust stake and of a swap with no pool, restart from SQLite, and the devnet HTTP API.

## What the devnet actually does

On first start the node writes a deterministic genesis:

| Piece | What it is |
|---|---|
| Supply | 1,000,000,000 LMN plus a 100,000,000 LMN faucet allocation, 6 decimal places |
| Validator | 1,000,000 LMN moved from the faucet, of which 10,000 LMN is staked |
| Pool | 10,000,000 LMN moved out of the treasury, paired with 10,000,000 internal USDC units |
| Blocks | One node produces a block every 4 seconds and keeps the mempool |
| Stake | A `stake:` transaction. The early-validator pool matches the staked amount 1:1 until that pool is empty |
| Swap | `swap:LMN/USDC` sells LMN for internal USDC. `swap-buy:` spends that USDC for LMN. The 0.30% fee stays in the pool |

Transaction fees are 0.001 LMN. 40% goes to the treasury, 40% is burned, 20% goes to the block producer.

## What this is not

- Not a mainnet and not a testnet other people can join safely. One process signs blocks with a published key.
- Not a connection to Base, Ethereum, or Uniswap. The keeper code can quote Base mainnet, and this devnet does not call it.
- Not a custody or exchange product. Internal USDC is a number in the node's database.
- Not audited. Signatures are ed25519 and the stake-weighted proposer is deterministic, but finality, slashing, and networking are not production consensus.

An audit, an independent validator set, real liquidity, and a legal review are still required before any public launch. See the pull request notes for the gap and for the only revenue path that matches what the software can do today.

## Development

```bash
npm ci
npm test
npm run build
npx tsx cli/lumen.ts wallet new
```

MIT. The license is in `LICENSE`.
