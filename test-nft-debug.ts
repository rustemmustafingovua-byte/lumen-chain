import { mkdtempSync, realpathSync } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { runCli } from './test/helpers.ts'
import { createWallet } from './core/rpc.js'

async function main() {
  const tmp = realpathSync(mkdtempSync('/tmp/lumen-nft-test-'))
  const home = join(tmp, 'home')
  mkdirSync(join(home, '.lumen'), { recursive: true })
  
  const w = createWallet()
  writeFileSync(join(home, '.lumen', 'wallet.json'), JSON.stringify(w, null, 2))
  
  const r1 = await runCli(['nft', 'mint', 'ipfs://xyz'], home)
  console.log('MINT:', r1.code, r1.stdout.slice(0, 200))
  
  const idMatch = r1.stdout.match(/#(\d+)/)
  if (!idMatch) { console.log('No ID'); process.exit(1) }
  const id = idMatch[1]
  console.log('ID:', id)
  
  const r2 = await runCli(['nft', 'list', id, '1000'], home)
  console.log('LIST:', r2.code, r2.stdout.slice(0, 200))
  
  const r3 = await runCli(['nft', 'buy', id], home)
  console.log('BUY:', r3.code, r3.stdout.slice(0, 200))
}

main()
