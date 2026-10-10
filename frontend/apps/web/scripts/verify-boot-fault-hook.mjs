#!/usr/bin/env node
/**
 * Contract: the exit-gate boot fault switch exists ONLY in a hooks build.
 *
 * `@almamesh/browser`'s bootFaultInjection.ts lets an e2e make the first
 * boot's Pyodide Worker throw a real WebAssembly RuntimeError, to prove the
 * one automatic boot retry live (e2e/boot-retry.spec.ts). Every caller is
 * guarded by `import.meta.env.VITE_EXIT_GATE_HOOKS === "1"`, so a production
 * build must fold the guard away and ship none of it.
 *
 *   node scripts/verify-boot-fault-hook.mjs dist --absent         # production build (frontend gate)
 *   node scripts/verify-boot-fault-hook.mjs dist-verify --present # hooks build (Dagger browserJourneys)
 *
 * `--present` is the half that proves this check can fail: the same markers
 * must be found in the hooked build, in the main bundle AND the chart Worker.
 * Exit code is the verdict.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The page global an e2e arms, and the boot-request field the Worker reads.
// Both are property names, so minification keeps them verbatim.
const ARM_KEY = '__almameshArmBootWasmFault'
const WORKER_FIELD = 'injectWasmTrap'

const [distDir, mode] = process.argv.slice(2)
if (!distDir || (mode !== '--absent' && mode !== '--present')) {
  console.error('usage: verify-boot-fault-hook.mjs <dist> --absent|--present')
  process.exit(2)
}

const assetsDir = join(distDir, 'assets')
const scripts = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, text: readFileSync(join(assetsDir, name), 'utf8') }))
if (scripts.length === 0) {
  console.error(`no scripts under ${assetsDir}: not a built app`)
  process.exit(1)
}

const holding = (marker) => scripts.filter((s) => s.text.includes(marker)).map((s) => s.name)
const armHolders = holding(ARM_KEY)
const fieldHolders = holding(WORKER_FIELD)

if (mode === '--absent') {
  const leaked = [...new Set([...armHolders, ...fieldHolders])]
  if (leaked.length > 0) {
    console.error(`boot fault switch shipped in a production build: ${leaked.join(', ')}`)
    process.exit(1)
  }
  console.log(`ok  boot fault switch absent from ${scripts.length} production scripts`)
} else {
  const workerHasIt = fieldHolders.some((name) => name.startsWith('chartWorker-'))
  const mainHasIt = armHolders.some((name) => !name.startsWith('chartWorker-'))
  if (!workerHasIt || !mainHasIt) {
    console.error(
      `boot fault switch missing from the hooks build: arm=${armHolders.join(',') || 'none'} field=${fieldHolders.join(',') || 'none'}`,
    )
    process.exit(1)
  }
  console.log(`ok  boot fault switch present in the hooks build (${armHolders.join(', ')}; ${fieldHolders.join(', ')})`)
}
