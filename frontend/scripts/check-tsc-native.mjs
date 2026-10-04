// Fails unless every way the gate invokes `tsc` resolves to TypeScript 7.x.
// `typescript` 6.x is installed only for typescript-eslint and also ships a
// `tsc` bin; if bun ever links it first, typecheck would silently run on 6.x.
import { execFileSync } from 'node:child_process'

const probes = [
  ['node_modules/.bin/tsc', ['-v']],
  ['bun', ['run', 'tsc', '-v']],
]
let bad = 0
for (const [cmd, args] of probes) {
  const out = execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n').pop()
  const ok = /^Version 7\./.test(out)
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cmd} ${args.join(' ')} -> ${out}`)
}
if (bad) {
  console.error('tsc is not TypeScript 7.x; fix bin linking (see //typescript in package.json).')
  process.exit(1)
}
