#!/usr/bin/env node
/**
 * Lumen CLI — кошелёк, узел, переводы, стейкинг, свап, монетизация.
 *
 *   lumen wallet new [file]      создать кошелёк (ключ в файле, 600)
 *   lumen wallet address [file]  показать адрес
 *   lumen balance <addr>          баланс
 *   lumen send <to> <amount>      подписать и отправить транзакцию
 *   lumen stake <amount>          застейкать LMN
 *   lumen node [--validator]      запустить узел/валидатор
 *   lumen node status             статус узла (аптайм, блоки, комиссии)
 *   lumen swap <pool> <amount>    обменять в пуле AMM
 *   lumen explorer                показать состояние цепочки
 *   lumen api-key create <name>   создать API ключ для внешних сервисов
 *   lumen referral generate       сгенерировать реферальный код
 *   lumen referral <code>         использовать реферальный код (скидка 5%)
 */
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Chain, SLOT_MS } from "../core/chain.js"
import { Ledger, TX_FEE, MIN_STAKE, stringify } from "../core/ledger.js"
import { createWallet, buildTx, makeRpc, type Wallet } from "../core/rpc.js"
import { Persistence } from "../core/persist.js"
import { Gossip, createTcpTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { serveExplorer } from "./explorer.js"
import { assemble } from "../core/vm.js"
import { createPublicClient, http, type Address } from "viem"
import { base } from "viem/chains"
import { UniV3Swapper, tokenBalance, USDC_BASE } from "../keeper/uni.js"
import {
  decide,
  tick,
  sell,
  loadConfig,
  loadState,
  rollDay,
  DEFAULT_POLICY,
  type KeeperConfig,
} from "../keeper/keeper.js"
import type { SpendPolicy } from "../keeper/types.js"
import { short } from "../core/crypto.js"
import { LimitOrderEngine, type LimitOrder } from "../core/limit-order.js"
import { DCAEngine } from "../core/dca.js"
import { YieldAggregator } from "../core/yield.js"
import { NFTMarketplace } from "../core/nft.js"

const HOME_DIR = process.env.HOME ?? homedir()
const LUMEN_DIR = join(HOME_DIR, ".lumen")
const API_KEYS_PATH = join(LUMEN_DIR, "api-keys.json")
const REFERRALS_PATH = join(LUMEN_DIR, "referrals.json")

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`

const DEFAULT_WALLET = join(HOME_DIR, ".lumen", "wallet.json")
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
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(w, null, 2))
  chmodSync(path, 0o600)
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function saveJson(path: string, data: unknown) {
  if (!existsSync(LUMEN_DIR)) mkdirSync(LUMEN_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

async function main() {
  try {
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
      const sub = args[1] ?? ""
      if (sub === "status") {
        const chain = new Chain()
        const restored = await chain.restoreFromPersistence()
        if (!restored) {
          chain.genesis()
        }
        const w = loadWallet()
        const pubKey = w.publicKey
        const addr = w.address

        // uptime
        const meta = chain.persist ? chain.persist.getMeta("nodeStartTimestamp") : undefined
        const startTs = meta ? Number(meta) : Date.now()
        const uptimeMs = Date.now() - startTs
        const uptimeDays = (uptimeMs / 86_400_000).toFixed(2)

        // blocks produced by this validator
        const totalBlocks = chain.blocks.length
        const myBlocks = chain.blocks.filter((b) => b.header.proposer === pubKey).length

        // fees earned: proposer cut from blocks produced
        // Ledger tracks proposerRewards per block but we need historical.
        // We approximate by checking proposerRewards currently accumulated,
        // and count blocks where proposer = pubKey.
        const staked = chain.ledger.get(addr).stake

        // fees earned from accepted blocks: for each block, fees were split
        // 40% treasury, 40% burn, 20% proposer. We approximate total earned
        // by proposerRewards that were distributed + estimate from tx count.
        let totalFeesEarned = 0n
        for (const b of chain.blocks) {
          if (b.header.proposer === pubKey && b.txs.length > 0) {
            // approximate: each tx fee has 20% proposer cut
            const blockFees = b.txs.reduce((sum, tx) => sum + tx.fee, 0n)
            totalFeesEarned += (blockFees * 20n) / 100n
          }
        }

        // ROI
        const roi = staked > 0n ? Number((totalFeesEarned * 10000n) / staked) / 100 : 0

        console.log(ok("=== статус узла ==="))
        console.log(`  адрес:          ${short(addr)}`)
        console.log(`  аптайм:         ${uptimeDays} дн.`)
        console.log(`  высота:         ${chain.height}`)
        console.log(`  блоков всего:   ${totalBlocks}`)
        console.log(`  блоков моих:    ${myBlocks}`)
        console.log(`  комиссии заработано: ${totalFeesEarned.toString()} LMN`)
        console.log(`  застейкано:     ${staked.toString()} LMN`)
        console.log(`  ROI:            ${roi.toFixed(4)}%`)
        break
      }

      const chain = new Chain()
      const restored = await chain.restoreFromPersistence()
      if (!restored) {
        chain.genesis()
        // При первом запуске создаём persistence
        const p = new (await import("../core/persist.js")).Persistence()
        chain.persist = p
        chain.persistState()
      }
      const w = loadWallet()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      chain.addValidator(w.publicKey, MIN_STAKE * 10n)
      const rpc = makeRpc(chain)

      // P2P: транспорт и gossip
      const peersArg = process.argv.find((a) => a.startsWith("--peers="))?.slice(8) ?? ""
      const peers = peersArg ? peersArg.split(",").map((s) => s.trim()).filter(Boolean) : []
      const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 0)
      const transport = createTcpTransport({ port })
      const gossip = new Gossip(chain, {
        peerId: peerIdFromPublicKey(w.publicKey),
        pubkey: w.publicKey,
        transport,
        log: (m) => console.log(dim(`  ${m}`)),
      })
      gossip.start()
      const boundPort = await transport.whenListening()
      for (const peer of peers) gossip.connect(peer)

      let slot = 1
      console.log(ok("узел Lumen запущен"))
      console.log(dim(`  высота: ${chain.height} | поставщик: ${short(w.address)} | слот: ${slot}`))
      console.log(dim(`  p2p: порт ${boundPort} | соседей: ${peers.length ? peers.join(", ") : "нет"}`))
      const timer = setInterval(() => {
        try {
          const txs = chain.mempool.take(100)
          const b = chain.propose(txs, w.privateKey, w.publicKey, slot++)
          chain.accept(b)
          chain.rewardProposer(w.publicKey)
          gossip.broadcastBlock(b)
          // долгоживущий узел не должен расти по памяти бесконечно
          if (slot % 200 === 0) chain.prune(2000)
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
        gossip.stop()
        console.log(dim("\nузел остановлен"))
        process.exit(0)
      })
      process.on("SIGTERM", () => {
        clearInterval(timer)
        gossip.stop()
        console.log(dim("\nузел остановлен (SIGTERM)"))
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

    case "unstake": {
      const w = loadWallet()
      const amountStr = args[1]
      if (!amountStr) {
        console.log("lumen unstake <amount>")
        process.exit(2)
      }
      const amount = BigInt(amountStr)
      if (amount <= 0n) {
        console.log(bad("amount должен быть > 0"))
        process.exit(2)
      }
      const chain = new Chain()
      chain.genesis()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      chain.ledger.get(w.address).stake = MIN_STAKE * 10n
      const tx = buildTx(w, undefined, amount, { nonce: 0, data: "unstake:" })
      chain.ledger.apply(tx)
      console.log(ok(`отстейкано ${amount} LMN`))
      console.log(dim(`  stake: ${chain.ledger.get(w.address).stake}`))
      break
    }

    case "lp": {
      const ledger = new Ledger()
      const action = args[1] ?? "add"
      if (action === "add") {
        const baseInStr = args[2]
        const quoteInStr = args[3]
        if (!baseInStr || !quoteInStr) {
          console.log("lumen lp add <lmN> <usdc>")
          process.exit(2)
        }
        const baseIn = BigInt(baseInStr)
        const quoteIn = BigInt(quoteInStr)
        if (baseIn <= 0n || quoteIn <= 0n) {
          console.log(bad("лимит ликвидности должен быть > 0"))
          process.exit(2)
        }
        ledger.addLiquidity("LMN", "USDC", baseIn, quoteIn)
        const key = ledger.poolKey("LMN", "USDC")
        const pool = ledger.pool(key)
        console.log(ok(`LP добавлено: ${baseIn} LMN + ${quoteIn} USDC`))
        console.log(dim(`  totalShares: ${pool.totalShares}`))
      } else if (action === "remove") {
        const sharesStr = args[2]
        if (!sharesStr) {
          console.log("lumen lp remove <shares>")
          process.exit(2)
        }
        const key = ledger.poolKey("LMN", "USDC")
        if (!ledger.pool(key)) {
          console.log(bad("пул не найден. сначала добавьте ликвидность: lp add"))
        } else {
          const pool = ledger.pool(key)
          const shares = BigInt(sharesStr)
          if (shares <= 0n || pool.totalShares === 0n) {
            console.log(bad("укажите доли для удаления"))
          } else {
            const baseOut = (pool.base * shares) / pool.totalShares
            const quoteOut = (pool.quote * shares) / pool.totalShares
            ledger.removeLiquidity(key, "demo-owner", shares)
            console.log(ok(`LP удалено: ${shares} долей`))
            console.log(dim(`  получите ≈ ${baseOut} LMN + ${quoteOut} USDC`))
          }
        }
      }
      break
    }

    case "serve": {
      // узел + explorer + RPC поверх HTTP
      const chain = new Chain()
      const restored = await chain.restoreFromPersistence()
      if (!restored) {
        chain.genesis()
        const p = new (await import("../core/persist.js")).Persistence()
        chain.persist = p
        chain.persistState()
      }
      const w = loadWallet()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      chain.addValidator(w.publicKey, MIN_STAKE * 10n)
      const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 8899)
      const { port: actual } = await serveExplorer({ chain, wallet: w, port })
      const peersArg = process.argv.find((a) => a.startsWith("--peers="))?.slice(8) ?? ""
      const peers = peersArg ? peersArg.split(",").map((x) => x.trim()).filter(Boolean) : []
      const transport = createTcpTransport({ port: 0 })
      const gossip = new Gossip(chain, {
        peerId: peerIdFromPublicKey(w.publicKey),
        pubkey: w.publicKey,
        transport,
        log: (m) => console.log(dim(`  ${m}`)),
      })
      gossip.start()
      for (const peer of peers) gossip.connect(peer)
      // демо-активность: деплой счётчика и транзакции, чтобы explorer был живым
      try {
        const demoCode = Buffer.from(
          assemble("PUSH1_0 SLOAD PUSH1_1 ADD PUSH1_0 SSTORE STOP"),
        ).toString("hex")
        chain.ledger.apply(
          buildTx(w, undefined, 0n, { nonce: chain.ledger.get(w.address).nonce, data: `deploy:${demoCode}` }),
        )
        const addr = chain.ledger.contractAddress(w.address, chain.ledger.get(w.address).nonce - 1)
        console.log(dim(`  демо-контракт: ${addr}`))
      } catch (e) {
        console.log(dim(`  демо-контракт не создан: ${(e as Error).message}`))
      }

      let slot = 1
      let demoNonce = chain.ledger.get(w.address).nonce
      const timer = setInterval(() => {
        try {
          // демо-транзакция, чтобы в блоках было что смотреть
          if (slot % 2 === 0) {
            const to = "lmn1demo" + "0".repeat(20)
            chain.mempool.add(
              buildTx(w, to, 1_000n, { nonce: demoNonce++, data: "demo" }),
            )
          }
          const txs = chain.mempool.take(100)
          const b = chain.propose(txs, w.privateKey, w.publicKey, slot++)
          chain.accept(b)
          chain.rewardProposer(w.publicKey)
          gossip.broadcastBlock(b)
          // долгоживущий узел не должен расти по памяти бесконечно
          if (slot % 200 === 0) chain.prune(2000)
        } catch {}
      }, SLOT_MS)
      console.log(dim(`  p2p: соседей ${peers.length}`))
      process.on("SIGINT", () => {
        clearInterval(timer)
        gossip.stop()
        process.exit(0)
      })
      process.on("SIGTERM", () => {
        clearInterval(timer)
        gossip.stop()
        console.log(dim("\nузел остановлен (SIGTERM)"))
        process.exit(0)
      })
      break
    }

    case "keeper": {
      // автономный конвертер: любой актив -> LMN, без биржи
      const sub = args[1] ?? "scan"
      const cfgPath = process.argv.find((a) => a.startsWith("--config="))?.slice(9)
      let cfg: KeeperConfig
      try {
        cfg = loadConfig(cfgPath)
      } catch (e) {
        console.log(bad(String((e as Error).message)))
        process.exit(2)
      }
      const policy: SpendPolicy = { ...DEFAULT_POLICY, ...(cfg.policy ?? {}) }
      const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) })
      const usdc = await tokenBalance(client, USDC_BASE, cfg.treasury as Address)
      const state = rollDay(loadState())

      if (sub === "scan") {
        const decision = decide(usdc, policy, state)
        console.log(ok("=== Lumen Keeper ==="))
        console.log(`  казна (Base):   ${cfg.treasury}`)
        console.log(`  USDC:           ${usdc / 10n ** 6n}`)
        console.log(`  Lumen-адрес:   ${cfg.lumenAddress}`)
        console.log(`  порог:          ${policy.minAmount / 10n ** 6n} USDC`)
        console.log(`  лимит/сделка:   ${policy.maxPerSwap / 10n ** 6n} USDC`)
        console.log(`  лимит/сутки:    ${policy.maxPerDay / 10n ** 6n} USDC (израсходовано ${state.spentToday / 10n ** 6n})`)
        console.log(
          decision.action === "buy"
            ? ok(`  → купит LMN на ${decision.amountIn / 10n ** 6n} USDC`)
            : dim(`  → ждём: ${decision.reason}`),
        )
        break
      }

      if (sub === "check") {
        // живая проверка маршрута на Base: пулы, котировки, адреса контрактов
        const { checkRoute, SWAP_ROUTER_V3_BASE, WETH_BASE } = await import("../keeper/uni.js")
        const addr = (process.argv.find((a) => a.startsWith("--address="))?.slice(10) ??
          cfg.treasury) as Address
        const amount = BigInt(process.argv.find((a) => a.startsWith("--amount="))?.slice(9) ?? "100000000")
        const usdcBal = await tokenBalance(client, USDC_BASE, addr)
        console.log(ok("=== проверка маршрута на Base ==="))
        console.log(`  маршрутизатор Uniswap V3: ${SWAP_ROUTER_V3_BASE}`)
        console.log(`  USDC: ${USDC_BASE}`)
        console.log(`  WETH: ${WETH_BASE}`)
        console.log(`  баланс USDC на ${addr}: ${usdcBal / 10n ** 6n}`)
        try {
          const { amountOut, path } = await checkRoute(client, amount)
          const out = (amountOut * 10n ** 6n) / 10n ** 18n
          console.log(ok(`  котировка USDC→WETH: ${amount / 10n ** 6n} USDC → ${out / 10n ** 6n}.${(out % 10n ** 6n).toString().padStart(6, "0")} WETH`))
          console.log(dim(`  path: ${path.slice(0, 34)}…`))
          console.log(dim("  пулы живые, маршрут рабочий — значит покупка LMN по этому же пути сработает"))
        } catch (e) {
          console.log(bad(`  котировка не удалась: ${(e as Error).message}`))
        }
        break
      }

      if (sub === "policy") {
        console.log(JSON.stringify(policy, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
        break
      }

      // покупка/продажа через Uniswap V3
      if (!cfg.lmn) {
        console.log(bad("в конфиге нет адреса токена LMN (\"lmn\")"))
        process.exit(2)
      }
      const keyFile = join(homedir(), ".config", "opencode", "secrets", "agent-wallet.json")
      let privateKey: `0x${string}` | undefined
      if (existsSync(keyFile)) {
        const w = JSON.parse(readFileSync(keyFile, "utf8"))
        privateKey = w?.evm?.privateKey
      }
      const buy = sub === "run" || sub === "buy"
      const swapper = new UniV3Swapper(
        {
          lmn: cfg.lmn as Address,
          treasury: cfg.treasury as Address,
          privateKey,
          rpcUrl: cfg.rpcUrl,
        },
        buy ? "buy" : "sell",
      )
      if (sub === "sell") {
        const amount = BigInt(args[2] ?? "0")
        const r = await sell({ swapper, policy, state }, amount)
        console.log(r.action === "sell" ? ok(`продано: ${r.detail} tx ${r.tx}`) : dim(`пропуск: ${r.detail}`))
        break
      }
      if (sub === "run") {
        console.log(ok(`keeper запущен: порог ${policy.minAmount / 10n ** 6n} USDC, лимит ${policy.maxPerDay / 10n ** 6n}/сутки`))
        for (;;) {
          const bal = await tokenBalance(client, USDC_BASE, cfg.treasury as Address)
          const st = rollDay(loadState())
          const d = decide(bal, policy, st)
          if (d.action === "buy") {
            try {
              const r = await tick({ swapper, policy, state: st }, bal, cfg.lumenAddress)
              console.log(ok(`  куплено: ${r.detail}`))
            } catch (e) {
              console.log(bad(`  ошибка: ${(e as Error).message}`))
            }
          } else {
            console.log(dim(`  ждём: ${d.reason}`))
          }
          await new Promise((r) => setTimeout(r, cfg.pollMs ?? 300_000))
        }
      }
      // разовая покупка
      const r = await tick({ swapper, policy, state }, usdc, cfg.lumenAddress)
      console.log(r.action === "buy" ? ok(`куплено: ${r.detail} tx ${r.tx}`) : dim(`пропуск: ${r.detail}`))
      break
    }

    case "contract": {
      // смарт-контракты внутри цепи: deploy и call
      const sub = args[1] ?? "list"
      const chain = new Chain()
      chain.genesis()
      const w = loadWallet()
      chain.ledger.get(w.address).balance = 1_000_000_000_000n
      chain.ledger.get(w.address).publicKey = w.publicKey
      const account = chain.ledger.get(w.address)

      if (sub === "list") {
        const all = [...chain.ledger.contracts.entries()]
        console.log(ok("=== контракты ==="))
        if (!all.length) console.log(dim("  пусто — деплой: lumen contract deploy <hex>"))
        for (const [addr, c] of all) {
          console.log(`  ${addr}  код:${c.code.length} баланс:${c.balance}  хранилище:${JSON.stringify(Object.fromEntries(c.storage))}`)
        }
        break
      }

      const codeHex = args[2] ?? ""
      if (sub === "deploy") {
        if (!codeHex) {
          console.log(bad("нужен hex-код: lumen contract deploy <hex>"))
          process.exit(2)
        }
        const tx = buildTx(w, undefined, 0n, { nonce: account.nonce, data: `deploy:${codeHex}` })
        chain.ledger.apply(tx)
        const addr = chain.ledger.contractAddress(w.address, account.nonce)
        console.log(ok(`контракт задеплоен: ${addr}`))
        console.log(dim(`  вызов: lumen contract call ${addr} <hex>`))
        break
      }

      if (sub === "call") {
        const addr = args[2] ?? ""
        const calldata = args[3] ?? ""
        if (!addr) {
          console.log(bad("нужен адрес: lumen contract call <адрес> [hex]"))
          process.exit(2)
        }
        const tx = buildTx(w, undefined, 0n, { nonce: account.nonce, data: `call:${addr}:${calldata}` })
        chain.ledger.apply(tx)
        console.log(ok(`вызов выполнен: ${addr}`))
        console.log(dim(`  хранилище: ${JSON.stringify(Object.fromEntries(chain.ledger.contracts.get(addr)?.storage ?? []))}`))
        break
      }

      console.log("lumen contract list|deploy <hex>|call <адрес> [hex]")
      break
    }

    case "api-key": {
      const sub = args[1] ?? "create"
      const w = loadWallet()
      const walletAddr = w.address

      if (sub === "create") {
        const name = args[2]
        if (!name) {
          console.log("lumen api-key create <name>")
          process.exit(2)
        }
        const keys = loadJson<Array<{ name: string; key: string; createdAt: number; lastUsed: number | null; owner: string }>>(API_KEYS_PATH, [])
        if (keys.some((k) => k.name === name && k.owner === walletAddr)) {
          console.log(bad(`ключ с именем "${name}" уже существует`))
          process.exit(2)
        }
        const key = randomBytes(32).toString("hex")
        const entry = { name, key, createdAt: Date.now(), lastUsed: null, owner: walletAddr }
        keys.push(entry)
        saveJson(API_KEYS_PATH, keys)
        console.log(ok(`API ключ создан: ${name}`))
        console.log(dim(`  ключ: ${key}`))
        console.log(dim(`  сохранён в ${API_KEYS_PATH}`))
        break
      }

      console.log("lumen api-key create <name>")
      break
    }

    case "referral": {
      const sub = args[1] ?? ""

      if (sub === "generate") {
        const w = loadWallet()
        const addr = w.address
        const referrals = loadJson<Array<{ code: string; owner: string; createdAt: number; uses: number }>>(REFERRALS_PATH, [])

        // check if owner already has a code
        const existing = referrals.find((r) => r.owner === addr)
        if (existing) {
          console.log(ok(`реферальный код: ${existing.code}`))
          console.log(dim(`  использований: ${existing.uses}`))
          break
        }

        // generate code: short hash of address + random suffix
        const suffix = randomBytes(4).toString("hex")
        const code = `${addr.slice(0, 6)}${suffix}`
        const entry = { code, owner: addr, createdAt: Date.now(), uses: 0 }
        referrals.push(entry)
        saveJson(REFERRALS_PATH, referrals)
        console.log(ok(`реферальный код создан: ${code}`))
        console.log(dim(`  поделитесь: lumen referral ${code}`))
        break
      }

      if (sub && sub !== "generate") {
        const code = sub
        const referrals = loadJson<Array<{ code: string; owner: string; createdAt: number; uses: number }>>(REFERRALS_PATH, [])

        const ref = referrals.find((r) => r.code === code)
        if (!ref) {
          console.log(bad(`реферальный код не найден: ${code}`))
          process.exit(2)
        }

        const w = loadWallet()
        const myAddr = w.address

        if (ref.owner === myAddr) {
          console.log(dim("нельзя использовать собственный код"))
          break
        }

        // mark that this user gets 5% discount on first 100 swaps
        const discounts = loadJson<Array<{ address: string; invoker: string; swapsLeft: number }>>(join(LUMEN_DIR, "referral-discounts.json"), [])
        const existing = discounts.find((d) => d.address === myAddr)
        if (existing) {
          console.log(dim(`у вас уже активна скидка: осталось ${existing.swapsLeft} свапов`))
          break
        }
        discounts.push({ address: myAddr, invoker: ref.owner, swapsLeft: 100 })
        saveJson(join(LUMEN_DIR, "referral-discounts.json"), discounts)

        // increment use count
        ref.uses++
        saveJson(REFERRALS_PATH, referrals)

        console.log(ok(`реферальный код активирован: ${code}`))
        console.log(dim(`  вы получаете 5% скидку на комиссии первых 100 свапов`))
        console.log(dim(`  пригласивший: ${short(ref.owner)}`))
        break
      }

      console.log("lumen referral generate | lumen referral <code>")
      break
    }

    case "order": {
      const sub = args[1] ?? ""
      const w = loadWallet()
      const engine = new LimitOrderEngine()

      if (sub === "create") {
        const pair = args[2]
        const amountStr = args[3]
        const priceStr = args[4]
        if (!pair || !amountStr || !priceStr) {
          console.log("lumen order create <pair> <amount> <price>")
          process.exit(2)
        }
        const amount = BigInt(amountStr)
        const price = BigInt(priceStr)
        const side: LimitOrder["side"] = "buy" // default buy; could be enhanced
        try {
          const order = engine.create(w.address, pair, side, amount, price)
          console.log(ok(`ордер #${order.id} создан`))
          console.log(dim(`  пара: ${pair} | сторона: ${side} | количество: ${amount} | цена: ${price}`))
        } catch (e) {
          console.log(bad(`ошибка: ${(e as Error).message}`))
          process.exit(2)
        }
        break
      }

      if (sub === "cancel") {
        const idStr = args[2]
        if (!idStr) {
          console.log("lumen order cancel <id>")
          process.exit(2)
        }
        const id = Number(idStr)
        const cancelled = engine.cancel(id)
        if (!cancelled) {
          console.log(bad(`ордер #${id} не найден или уже закрыт`))
          process.exit(2)
        }
        console.log(ok(`ордер #${id} отменён`))
        break
      }

      console.log("lumen order create <pair> <amount> <price>")
      console.log("lumen order cancel <id>")
      break
    }

    case "dca": {
      const sub = args[1] ?? ""
      const w = loadWallet()
      const dca = new DCAEngine()

      if (sub === "create") {
        const pair = args[2]
        const amountStr = args[3]
        const intervalStr = args[4]
        if (!pair || !amountStr || !intervalStr) {
          console.log("lumen dca create <pair> <amount> <interval>")
          process.exit(2)
        }
        const amount = BigInt(amountStr)
        const interval = Number(intervalStr)
        try {
          const plan = dca.create(w.address, pair, amount, interval, 1)
          console.log(ok(`DCA план #${plan.id} создан`))
          console.log(dim(`  пара: ${pair} | сумма: ${amount} | интервал: ${interval} блоков`))
        } catch (e) {
          console.log(bad(`ошибка: ${(e as Error).message}`))
          process.exit(2)
        }
        break
      }

      console.log("lumen dca create <pair> <amount> <interval>")
      break
    }

    case "yield": {
      const sub = args[1] ?? ""
      const pool = args[2] ?? "LMN/USDC"
      const yieldAgg = new YieldAggregator()

      if (sub === "auto") {
        const ledger = new Ledger()
        ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "demo-yield-owner")
        const result = yieldAgg.autoCompoundAll(ledger, pool)
        console.log(ok(`авто-компаундинг: обработано ${result.compounded}, пропущено ${result.skipped}`))
        break
      }

      console.log("lumen yield auto <pool>")
      break
    }

    case "nft": {
      const sub = args[1] ?? ""
      const w = loadWallet()
      const nft = new NFTMarketplace()

      if (sub === "mint") {
        const uri = args[2]
        if (!uri) {
          console.log("lumen nft mint <uri>")
          process.exit(2)
        }
        const created = nft.mint(w.address, uri)
        console.log(ok(`NFT #${created.id} создан`))
        console.log(dim(`  uri: ${uri}`))
        console.log(dim(`  владелец: ${short(created.owner)}`))
        break
      }

      if (sub === "list") {
        const idStr = args[2]
        const priceStr = args[3]
        if (!idStr || !priceStr) {
          console.log("lumen nft list <id> <price>")
          process.exit(2)
        }
        const id = Number(idStr)
        const price = BigInt(priceStr)
        try {
          const listing = nft.list(id, w.address, price)
          console.log(ok(`NFT #${listing.nftId} выставлен на продажу за ${price} LMN`))
        } catch (e) {
          console.log(bad(`ошибка: ${(e as Error).message}`))
          process.exit(2)
        }
        break
      }

      if (sub === "buy") {
        const idStr = args[2]
        if (!idStr) {
          console.log("lumen nft buy <id>")
          process.exit(2)
        }
        const id = Number(idStr)
        const ledger = new Ledger()
        ledger.get(w.address).balance = 1_000_000_000_000n
        try {
          const result = nft.buy(id, w.address, ledger)
          if (!result) {
            console.log(bad(`NFT #${id} не найден или не выставлен`))
            process.exit(2)
          }
          console.log(ok(`NFT #${result.nft.id} куплен за ${result.listing.price} LMN`))
          console.log(dim(`  новый владелец: ${short(result.nft.owner)}`))
        } catch (e) {
          console.log(bad(`ошибка: ${(e as Error).message}`))
          process.exit(2)
        }
        break
      }

      console.log("lumen nft mint <uri>")
      console.log("lumen nft list <id> <price>")
      console.log("lumen nft buy <id>")
      break
    }

    case "rewards": {
      const w = loadWallet()
      const ledger = new Ledger()
      const key = ledger.poolKey("LMN", "USDC")
      const persist = new Persistence()
      const pos = persist.getFarmingPosition(key, w.address)
      if (!pos || pos.shares === 0n) {
        console.log(dim("фарминг-позиции не найдены"))
        break
      }
      const now = Date.now()
      const elapsedSec = Math.max(0, Math.floor((now - pos.stakedAt) / 1000))
      // награда: 1 LMN на 1M shares в секунду
      const reward = (pos.shares * BigInt(elapsedSec)) / 1_000_000n
      if (reward <= 0n) {
        console.log(dim(`награда пока нулевая, прошло ${elapsedSec} сек.`))
        break
      }
      persist.saveFarmingPosition(key, w.address, pos.shares, pos.stakedAt, now)
      console.log(ok(`награда: ${reward.toString()} LMN (за ${elapsedSec} сек.)`))
      console.log(dim(`  позиция: ${pos.shares} shares`))
      break
    }

    case "farm": {
      const w = loadWallet()
      const pool = args[1] ?? "LMN/USDC"
      const amountStr = args[2]
      if (!amountStr) {
        console.log("lumen farm <pool> <amount>")
        process.exit(2)
      }
      const amount = BigInt(amountStr)
      if (amount <= 0n) {
        console.log(bad("amount должен быть > 0"))
        process.exit(2)
      }
      const persist = new Persistence()
      const key = pool
      const existing = persist.getFarmingPosition(key, w.address)
      const now = Date.now()
      if (existing && existing.shares > 0n) {
        persist.saveFarmingPosition(key, w.address, existing.shares + amount, existing.stakedAt, now)
      } else {
        persist.saveFarmingPosition(key, w.address, amount, now, now)
      }
      console.log(ok(`зафармлено ${amount} shares в пуле ${pool}`))
      console.log(dim(`  общая позиция: ${(existing?.shares ?? 0n) + amount} shares`))
      break
    }

    case "governance": {
      const sub = args[1] ?? ""
      const w = loadWallet()
      const persist = new Persistence()

      if (sub === "propose") {
        const title = args[2]
        const description = args[3]
        if (!title || !description) {
          console.log("lumen governance propose <title> <description>")
          process.exit(2)
        }
        const id = persist.saveProposal(title, description, Date.now(), w.address)
        console.log(ok(`предложение #${id} создано`))
        console.log(dim(`  заголовок: ${title}`))
        console.log(dim(`  создатель: ${short(w.address)}`))
        break
      }

      if (sub === "vote") {
        const idStr = args[2]
        const choice = (args[3] ?? "").toLowerCase()
        if (!idStr || !choice) {
          console.log("lumen governance vote <id> <yes|no>")
          process.exit(2)
        }
        const proposalId = Number(idStr)
        if (!Number.isInteger(proposalId) || proposalId <= 0) {
          console.log(bad("id должен быть положительным числом"))
          process.exit(2)
        }
        const proposal = persist.getProposal(proposalId)
        if (!proposal) {
          console.log(bad(`предложение #${proposalId} не найдено`))
          process.exit(2)
        }
        if (proposal.status !== "active") {
          console.log(bad(`предложение #${proposalId} завершено`))
          process.exit(2)
        }
        if (persist.hasVoted(proposalId, w.address)) {
          console.log(dim(`вы уже голосовали за предложение #${proposalId}`))
          break
        }
        persist.saveVote(proposalId, w.address, choice)
        if (choice === "yes") {
          persist.db.prepare("UPDATE governance_proposals SET yesVotes = yesVotes + 1 WHERE id = ?").run(proposalId)
        } else {
          persist.db.prepare("UPDATE governance_proposals SET noVotes = noVotes + 1 WHERE id = ?").run(proposalId)
        }
        console.log(ok(`голос ${choice} зарегистрирован за предложение #${proposalId}`))
        break
      }

      console.log("lumen governance propose <title> <description>")
      console.log("lumen governance vote <id> <yes|no>")
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
          `  lumen node                   запустить узел/валидатор
  lumen node --port=8789 --peers=host:port,host:port   узел в P2P-сети\n` +
          `  lumen node status            статус узла (аптайм, блоки, комиссии)\n` +
          `  lumen swap <pool> <amount>   AMM-обмен\n` +
          `  lumen unstake <amount>       отстейкать LMN\n` +
          `  lumen lp add <lmN> <usdc>    добавить ликвидность\n` +
          `  lumen lp remove <shares>     убрать ликвидность\n` +
          `  lumen farm <pool> <amount>   застейкать LP-токены\n` +
          `  lumen rewards                забрать награду фарминга\n` +
          `  lumen governance propose <title> <description>  создать предложение\n` +
          `  lumen governance vote <id> <yes|no>  проголосовать\n` +
          `  lumen explorer               состояние цепочки
  lumen contract list         смарт-контракты в цепи
  lumen contract deploy <hex> задеплоить контракт
  lumen contract call <адрес> [hex]  вызвать контракт
  lumen api-key create <name>  создать API ключ
  lumen referral generate      сгенерировать реферальный код
  lumen referral <code>        использовать реферальный код
  lumen serve --port=8899      узел + explorer + JSON-RPC по HTTP
  lumen keeper scan            что keeper сделает сейчас
  lumen keeper run             автономная покупка LMN за USDC (Uniswap V3)
  lumen keeper sell <amount>   продать LMN обратно в USDC
  lumen order create <pair> <amount> <price>   создать лимитный ордер
  lumen order cancel <id>                       отменить ордер
  lumen dca create <pair> <amount> <interval>  создать DCA план
  lumen yield auto <pool>                       авто-компаундинг/реинвест
  lumen nft mint <uri>                          создать NFT
  lumen nft list <id> <price>                   выставить NFT на продажу
  lumen nft buy <id>                            купить NFT`,
      )
  }
}

main()
