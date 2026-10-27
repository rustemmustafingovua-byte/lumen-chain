/**
 * Lumen — сбор отчёта покрытия тестами.
 *
 * Запускает тестовый сьюит и выводит сводку.
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const COVERAGE_DIR = join(process.cwd(), ".coverage")
const REPORT_PATH = join(COVERAGE_DIR, "coverage-summary.json")
const PROJECT_ROOT = process.cwd()

function runTests(): { stdout: string; stderr: string; exitCode: number } {
  try {
    const out = execSync("npx tsx --test test/*.test.ts", {
      encoding: "utf8",
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_ENV: "test", FORCE_COLOR: "0" },
      timeout: 120_000,
    })
    return { stdout: out, stderr: "", exitCode: 0 }
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    }
  }
}

function extractSummary(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n")
  const summary: Record<string, unknown> = { passed: 0, failed: 0, skipped: 0, tests: 0, durationMs: 0 }

  for (const line of lines) {
    const m = line.match(/(\d+)\s+(passed|failed|skipped)/i)
    if (m) {
      const count = Number.parseInt(m[1], 10)
      const kind = m[2].toLowerCase()
      if (kind === "passed") summary.passed = count
      else if (kind === "failed") summary.failed = count
      else if (kind === "skipped") summary.skipped = count
    }
    if (line.includes("|") && line.includes("ms")) {
      const dm = line.match(/(\d+)\s*ms/)
      if (dm) summary.durationMs = Number.parseInt(dm[1], 10)
    }
  }
  summary.tests = (summary.passed as number) + (summary.failed as number) + (summary.skipped as number)
  summary.stdoutLines = lines.length
  summary.rawTail = stdout.slice(-2000)
  return summary
}

function writeReport(summary: Record<string, unknown>): void {
  const dir = join(PROJECT_ROOT, ".coverage")
  try {
    if (!existsSync(dir)) require("node:fs").mkdirSync(dir, { recursive: true })
  } catch {}
  try {
    require("node:fs").writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2))
    console.log(`отчёт покрытия: ${REPORT_PATH}`)
  } catch (e) {
    console.warn(`не удалось записать отчёт: ${(e as Error).message}`)
  }
}

function printSummary(summary: Record<string, unknown>): void {
  console.log("=== покрытие тестами ===")
  console.log(`  всего тестов:    ${summary.tests}`)
  console.log(`  пройдено:        ${summary.passed}`)
  console.log(`  упало:           ${summary.failed}`)
  console.log(`  пропущено:       ${summary.skipped}`)
  console.log(`  длительность:    ${summary.durationMs}ms`)
  if ((summary.failed as number) > 0) {
    console.log("\n--- последние строки вывода ---")
    console.log((summary.rawTail as string) || "(пусто)")
  }
}

function main(): void {
  console.log("запуск тестов...")
  const { stdout, stderr, exitCode } = runTests()
  const summary = extractSummary(stdout + stderr)
  writeReport(summary)
  printSummary(summary)
  if (exitCode !== 0) {
    console.error(`\nтесты завершились с кодом ${exitCode}`)
    process.exit(exitCode)
  }
}

main()
