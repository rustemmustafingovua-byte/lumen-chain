import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createWallet } from './core/rpc.js'

function runCli(args: string[], home: string) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home }
    const LUMEN_TS = join(process.cwd(), 'cli', 'lumen.ts')
    const child = spawn(process.execPath, [join(process.cwd(), 'node_modules', '.bin', 'tsx'), LUMEN_TS, ...args], { env })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => stdout += d.toString())
    child.stderr.on('data', d => stderr += d.toString())
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

async function main() {
  const tmp = join(tmpdir(), 'lumen-nft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const home = join(tmp, 'home')
  mkdirSync(join(home, '.lumen'), { recursive: true })
  const w = createWallet()
  writeFileSync(join(home, '.lumen', 'wallet.json'), JSON.stringify(w))

  const r1 = await runCli(['nft', 'mint', 'ipfs://xyz'], home)
  console.log('MINT:', r1.code, r1.stdout.trim())

  const idMatch = r1.stdout.match(/#(\d+)/)
  if (!idMatch) { console.log('No ID'); process.exit(1) }
  const id = idMatch[1]
  console.log('ID:', id)

  const r2 = await runCli(['nft', 'list', id, '1000'], home)
  console.log('LIST:', r2.code, r2.stdout.trim())

  const r3 = await runCli(['nft', 'buy', id], home)
  console.log('BUY:', r3.code, r3.stdout.trim())
  if (r3.stderr) console.log('STDERR:', r3.stderr.trim().slice(0, 300))
}

main()
