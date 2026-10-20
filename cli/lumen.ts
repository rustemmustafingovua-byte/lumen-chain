#!/usr/bin/env node
/**
 * Lumen CLI — кошелёк, узел, переводы, стейкинг, свап.
 *
 *   lumen wallet new [file]      создать кошелёк (ключ в файле, 600)
 *   lumen wallet address [file]  показать адрес
 *   lumen balance <addr>          баланс
 *   lumen send <to> <amount>      подписать и отправить транзакцию
 *   lumen stake <amount>          застейкать LMN
 *   lumen node [--validator]      запустить узел/валидатор
 *   lumen swap <pool> <amount>    обменять в пуле AMM
 *   lumen explorer                показать состояние цепочки
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Chain, SLOT_MS } from "../core/chain.js"
import { Ledger, TX_FEE, MIN_STAKE, stringify } from "../core/ledger.js"
import { createWallet, buildTx, makeRpc, type Wallet } from "../core/rpc.js"
import { short } from "../core/crypto.js"

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`

const DEFAULT_WALLET = join(homedir(), ".lumen", "wallet.json")
const args = process.argv.slice(2)
const cmd = args[0] ?? "help"

function loadWallet(path = DEFAULT_WALLET): Wallet {
  if (!existsSync(path)) {
    console.log(bad(`кошелёк не найден: ${path}\n  создайте: lumen wallet new`))
    process.exit(2)
  }
  const raw = JSON.parse(readFileSync(path, "utf8"))
  return raw as Wallet
}

function saveWallet(w: Wallet, path = DEFAULT_WALLET) {
  const dir = path.slice(0, path.lastIndexOf("/"))
  try {
    require("node:fs").mkdirSync(dir, { recursive: true })
  } catch {}
  writeFileSync(path, JSON.stringify(w, null, 2))
  chmodSync(path, 0o600)
}

async function main() {
  switch (cmd) {
    case "wallet": {
      const sub = args[1] ?? "new"
      const path = args[2] && args[2].endsWith(".json") ? args[2] : DEFAULT_WALLET
      if (sub === "new") {
        const w = createWallet()
        saveWallet(w, path)
        console.log(ok("кошелёк создан"))
        console.log(`  адрес: ${w.address}`)
        console.log(dim(`  файл:  ${path} (600)`))
        console.log(dim("  Слейте этому адресу LMN — и он станет вашим кошельком в сети Lumen."))
      } else if (sub === "address") {
        const w = loadWallet(path)
        console.log(w.address)
      } else {
        console.log("lumen wallet new|address")
      }
      break
    }

    case "balance": {
      const chain = new Chain()
      chain.genesis()
      const addr = args[1]
      console.log(`${addr}: ${chain.ledger.balance(addr).toString()} LMN`)
      break
    }

    case "send": {
      const w = loadWallet()
      const to = args[1]
      const amount = BigInt(args[2] ?? "0")
      if (!to || !amount) {
        console.log("lumen send <to> <amount>")
        process.exit(2)
      }
      const chain = new Chain()
      chain.genesis()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      const tx = buildTx(w, to, amount, { nonce: chain.ledger.get(w.address).nonce })
      chain.mempool.add(tx)
      console.log(ok("транзакция подписана и добавлена в пул"))
      console.log(dim(`  ${stringify(tx)}`))
      break
    }

    case "stake": {
      const w = loadWallet()
      const amount = BigInt(args[1] ?? MIN_STAKE.toString())
      const chain = new Chain()
      chain.genesis()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      const tx = buildTx(w, undefined, amount, { nonce: 0, data: "stake:" })
      chain.ledger.apply(tx)
      console.log(ok(`застейкано ${amount} LMN`))
      console.log(dim(`  stake: ${chain.ledger.get(w.address).stake}`))
      break
    }

    case "node": {
      const chain = new Chain()
      chain.genesis()
      const w = loadWallet()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      chain.addValidator(w.publicKey, MIN_STAKE * 10n)
      const rpc = makeRpc(chain)
      let slot = 1
      console.log(ok("узел Lumen запущен"))
      console.log(dim(`  высота: ${chain.height} | поставщик: ${short(w.address)} | слот: ${slot}`))
      const timer = setInterval(() => {
        try {
          const txs = chain.mempool.take(100)
          const b = chain.propose(txs, w.privateKey, w.publicKey, slot++)
          chain.accept(b)
          chain.rewardProposer(w.publicKey, 1)
          console.log(
            dim(
              `  #${b.header.height} txs:${b.txs.length} pool:${chain.mempool.size} hash:${b.hash.slice(0, 12)}`,
            ),
          )
        } catch (e) {
          console.log(bad(`  ошибка блока: ${(e as Error).message}`))
        }
      }, SLOT_MS)
      process.on("SIGINT", () => {
        clearInterval(timer)
        console.log(dim("\nузел остановлен"))
        process.exit(0)
      })
      break
    }

    case "swap": {
      const ledger = new Ledger()
      const key = ledger.poolKey("LMN", "USDC")
      ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n)
      const amount = BigInt(args[2] ?? "1000")
      const out = ledger.quoteSwap(key, amount)
      console.log(`за 1 ${amount} LMN получите ≈ ${out} USDC`)
      break
    }

    case "explorer": {
      const chain = new Chain()
      chain.genesis()
      const rpc = makeRpc(chain)
      console.log(ok("состояние цепочки"))
      console.log(`  chainId:   ${rpc("lumen_chainId")}`)
      console.log(`  height:    ${rpc("lumen_blockNumber")}`)
      console.log(`  supply:    ${rpc("lumen_totalSupply")}`)
      console.log(`  stateRoot: ${String(rpc("lumen_stateRoot")).slice(0, 24)}…`)
      break
    }

    default:
      console.log(
        `lumen — CLI сети Lumen\n\n` +
          `  lumen wallet new [file]     создать кошелёк\n` +
          `  lumen wallet address [file] показать адрес\n` +
          `  lumen send <to> <amount>     подписать транзакцию\n` +
          `  lumen stake <amount>         стейкинг\n` +
          `  lumen node                   запустить узел/валидатор\n` +
          `  lumen swap <pool> <amount>   AMM-обмен\n` +
          `  lumen explorer               состояние цепочки`,
      )
  }
}

main()
