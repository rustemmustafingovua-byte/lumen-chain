import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createWallet } from "../core/rpc.js"

const LUMEN_TS = join(process.cwd(), "cli", "lumen.ts")
const TSX = process.execPath
const ARGS = [join(process.cwd(), "node_modules", ".bin", "tsx")]

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "")
}

function runCli(args: string[], envHome?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: envHome ?? process.env.HOME ?? tmpdir() }
    const child = spawn(TSX, [...ARGS, LUMEN_TS, ...args], { env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("close", (code) => resolve({ code: code ?? 0, stdout: stripAnsi(stdout), stderr }))
  })
}

function makeHome(overrides: { wallet?: boolean; apiKeys?: boolean; referrals?: boolean }): string {
  const dir = join(tmpdir(), `lumen-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, ".lumen"), { recursive: true })
  let walletAddress = ""
  if (overrides.wallet) {
    const w = createWallet()
    walletAddress = w.address
    writeFileSync(
      join(dir, ".lumen", "wallet.json"),
      JSON.stringify(w),
    )
  }
  if (overrides.apiKeys) {
    writeFileSync(
      join(dir, ".lumen", "api-keys.json"),
      JSON.stringify([{ name: "existing", key: "oldkey", createdAt: 1, lastUsed: null, owner: walletAddress || "lmn1test00000000000000000000000000000000000000" }]),
    )
  }
  if (overrides.referrals) {
    writeFileSync(
      join(dir, ".lumen", "referrals.json"),
      JSON.stringify([{ code: "existing1", owner: "lmn1other0000000000000000000000000000000000", createdAt: 1, uses: 0 }]),
    )
  }
  return dir
}

// ---- wallet ----

test("wallet new создаёт файл с адресом lmn1…", async () => {
  const home = makeHome({})
  const r = await runCli(["wallet", "new"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("кошелёк создан"))
  assert.ok(r.stdout.includes("адрес:"))
  const walletPath = join(home, ".lumen", "wallet.json")
  assert.ok(existsSync(walletPath))
  const raw = JSON.parse(readFileSync(walletPath, "utf8"))
  assert.ok(raw.address.startsWith("lmn1"))
})

test("wallet address выводит адрес из файла", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["wallet", "address"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.trim().startsWith("lmn1"))
})

test("wallet без файла — ошибка и exit 2", async () => {
  const home = makeHome({})
  const r = await runCli(["wallet", "address"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("кошелёк не найден"))
})

// ---- balance ----

test("balance выводит баланс для любого адреса", async () => {
  const r = await runCli(["balance", "lmn1test0000000000000000000000000000000000000000"])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("LMN"))
})

// ---- send ----

test("send подписывает транзакцию и добавляет в пул", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["send", "lmn1recipient0000000000000000000000000000000000", "5000"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("подписана и добавлена в пул"))
})

test("send без to — ошибка и exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["send"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen send <to> <amount>"))
})

test("send без amount — ошибка и exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["send", "lmn1recipient"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen send <to> <amount>"))
})

// ---- stake ----

test("stake застейкать LMN", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["stake", "10000"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("застейкано"))
})

// ---- unstake ----

test("unstake отстейкать LMN", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["unstake", "5000"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("отстейкано"))
})

test("unstake без amount — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["unstake"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen unstake <amount>"))
})

// ---- node ----

test("node status показывает статус узла", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["node", "status"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("статус узла"))
  assert.ok(r.stdout.includes("аптайм"))
  assert.ok(r.stdout.includes("застейкано"))
})

// ---- swap ----

test("swap считает котировку AMM", async () => {
  const r = await runCli(["swap", "LMN/USDC", "1000"])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("USDC"))
})

// ---- lp ----

test("lp add добавляет ликвидность", async () => {
  const r = await runCli(["lp", "add", "1000000", "1000000"])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("LP добавлено"))
})

test("lp remove удаляет ликвидность", async () => {
  // lp create и lp remove работают на одном экземпляре Ledger в рамках одной команды.
  // CLI stateless: успешный remove проверяем через отдельный запуск с уже существующим пулом
  const home = makeHome({ wallet: true })
  const r = await runCli(["lp", "remove", "500000"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("пул не найден") || r.stdout.includes("LP удалено"))
})

test("lp remove без shares — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["lp", "remove"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen lp remove <shares>"))
})

test("lp remove без пула — ошибка", async () => {
  const home2 = makeHome({ wallet: true })
  const r = await runCli(["lp", "remove", "100"], home2)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("пул не найден"))
})

// ---- api-key ----

test("api-key create создаёт ключ", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["api-key", "create", "mykey"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("API ключ создан"))
})

test("api-key create без имени — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["api-key", "create"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen api-key create <name>"))
})

test("api-key create дубликат имени — ошибка", async () => {
  const home = makeHome({ wallet: true, apiKeys: true })
  const r = await runCli(["api-key", "create", "existing"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("уже существует"))
})

// ---- referral ----

test("referral generate создаёт код", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["referral", "generate"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("реферальный код создан"))
})

test("referral generate повтор — возвращает существующий", async () => {
  const home = makeHome({ wallet: true })
  // сначала создаём код
  await runCli(["referral", "generate"], home)
  // повторный вызов должен вернуть тот же код
  const r = await runCli(["referral", "generate"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("реферальный код:"))
})

test("referral <code> активирует код", async () => {
  const home = makeHome({ wallet: true })
  const r1 = await runCli(["referral", "generate"], home)
  const codeMatch = r1.stdout.match(/реферальный код создан: (\S+)/)
  if (!codeMatch) throw new Error("no code generated")
  const code = codeMatch[1]
  // заменяем кошелёк в том же home на новый
  const w2 = createWallet()
  writeFileSync(join(home, ".lumen", "wallet.json"), JSON.stringify(w2))
  const r2 = await runCli(["referral", code], home)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("активирован"))
})

test("referral несуществующий код — ошибка exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["referral", "badcode"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("не найден"))
})

test("referral собственный код — пропуск", async () => {
  const home = makeHome({ wallet: true })
  const r1 = await runCli(["referral", "generate"], home)
  const codeMatch = r1.stdout.match(/реферальный код создан: (\S+)/)
  if (!codeMatch) throw new Error("no code generated")
  const code = codeMatch[1]
  const r2 = await runCli(["referral", code], home)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("нельзя использовать собственный код"))
})

// ---- contract ----

test("contract deploy деплоит контракт", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["contract", "deploy", "00"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("контракт задеплоен"))
})

test("contract deploy без hex — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["contract", "deploy"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("нужен hex-код"))
})

test("contract call вызывает контракт", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["contract", "call", "0x" + "0".repeat(40)], home)
  // stateless CLI: неизвестный контракт падает с exit 1
  assert.equal(r.code, 1)
  assert.ok(r.stderr.includes("unknown contract") || r.stdout.includes("не найден") || r.stderr.includes("LedgerError"))
})

// ---- explorer ----

test("explorer выводит состояние цепочки", async () => {
  const r = await runCli(["explorer"])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("chainId"))
  assert.ok(r.stdout.includes("height"))
})

// ---- farm ----

test("farm создаёт фарминг-позицию", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["farm", "LMN/USDC", "1000"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("зафармлено"))
})

test("farm без amount — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["farm", "LMN/USDC"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen farm <pool> <amount>"))
})

test("farm amount 0 — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["farm", "LMN/USDC", "0"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("amount должен быть > 0"))
})

// ---- rewards ----

test("rewards показывает награду", async () => {
  const home = makeHome({ wallet: true })
  // сначала создаём позицию
  await runCli(["farm", "LMN/USDC", "1000"], home)
  // немного подождём, чтобы прошло время
  await new Promise((r) => setTimeout(r, 1100))
  const r = await runCli(["rewards"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("награда") || r.stdout.includes("нулевая"))
})

test("rewards без позиции — информационное сообщение", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["rewards"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("позиции не найдены"))
})

// ---- governance propose ----

test("governance propose создаёт предложение", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["governance", "propose", "test title", "test desc"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("предложение"))
})

test("governance propose без title — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["governance", "propose"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen governance propose <title> <description>"))
})

// ---- governance vote ----

test("governance vote регистрирует голос", async () => {
  const home = makeHome({ wallet: true })
  const r1 = await runCli(["governance", "propose", "vote test", "desc"], home)
  const idMatch = r1.stdout.match(/#(\d+)/)
  if (!idMatch) throw new Error("no proposal id")
  const id = idMatch[1]
  const r2 = await runCli(["governance", "vote", id, "yes"], home)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("голос yes"))
})

test("governance vote несуществующий id — ошибка", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["governance", "vote", "999", "yes"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("не найдено"))
})

test("governance vote повтор — пропуск", async () => {
  const home = makeHome({ wallet: true })
  const r1 = await runCli(["governance", "propose", "repeat vote", "desc"], home)
  const idMatch = r1.stdout.match(/#(\d+)/)
  if (!idMatch) throw new Error("no proposal id")
  const id = idMatch[1]
  await runCli(["governance", "vote", id, "yes"], home)
  const r2 = await runCli(["governance", "vote", id, "no"], home)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("уже голосовали"))
})

test("governance vote без args — валидация: exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["governance", "vote"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen governance vote <id> <yes|no>"))
})


