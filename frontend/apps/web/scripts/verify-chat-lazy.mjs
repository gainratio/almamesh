// Proves the Vercel AI SDK (`ai`) and zod ship ONLY in the lazy chat chunk.
// The initial dashboard load = the index.html entry's static closure plus the
// Dashboard route chunk's static closure (the route itself is lazy). Any chunk
// in that closure containing an SDK/zod marker fails the gate. The markers are
// string literals that survive minification; each was verified to appear in the
// lazy chunk and nowhere else. If NO chunk has them, the check is vacuous and
// also fails (a bundler change must not turn this into a silent pass).
// Usage: node verify-chat-lazy.mjs [distDir] [--json]
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

export const MARKERS = [
  'ai-gateway.vercel.sh', // `ai` (default gateway URL)
  'AI_NoSuchToolError', // `ai` error names
  '$ZodType', // zod v4 core
  'ZodError', // zod
]
const DASHBOARD_ENTRY = 'src/pages/Dashboard.tsx'
const INDEX_ENTRY = 'index.html'

export function staticClosure(manifest, entryKeys) {
  const seen = new Set()
  const walk = (key) => {
    if (seen.has(key) || !manifest[key]) return
    seen.add(key)
    for (const dep of manifest[key].imports ?? []) walk(dep)
  }
  entryKeys.forEach(walk)
  return seen
}

export function filesOf(manifest, keys) {
  const files = new Set()
  for (const key of keys) {
    const chunk = manifest[key]
    files.add(chunk.file)
    for (const css of chunk.css ?? []) files.add(css)
  }
  return [...files]
}

export function analyze(distDir) {
  const manifestPath = path.join(distDir, '.vite', 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no ${manifestPath} (build.manifest must be true)`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of [INDEX_ENTRY, DASHBOARD_ENTRY]) {
    if (!manifest[entry]) throw new Error(`manifest has no ${entry}`)
  }
  const read = (file) => readFileSync(path.join(distDir, file))
  const initialKeys = staticClosure(manifest, [INDEX_ENTRY, DASHBOARD_ENTRY])
  const initialFiles = filesOf(manifest, initialKeys)
  const leaks = []
  for (const file of initialFiles.filter((f) => f.endsWith('.js'))) {
    const text = read(file).toString('utf8')
    for (const marker of MARKERS) if (text.includes(marker)) leaks.push({ file, marker })
  }
  const lazy = Object.values(manifest)
    .map((chunk) => chunk.file)
    .filter((f) => f.endsWith('.js') && !initialFiles.includes(f))
    .filter((f) => MARKERS.some((m) => read(f).toString('utf8').includes(m)))
  const gz = (files) => files.reduce((sum, f) => sum + gzipSync(read(f)).length, 0)
  return {
    leaks,
    lazy: lazy.map((file) => ({ file, gzip: gz([file]) })),
    initialFiles,
    initialGzip: gz(initialFiles),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const distDir = path.resolve(process.argv[2] ?? 'dist')
  const result = analyze(distDir)
  const kb = (n) => `${(n / 1024).toFixed(1)} kB`
  console.log(`initial (index + Dashboard) closure: ${result.initialFiles.length} files, ${kb(result.initialGzip)} gzip`)
  for (const { file, gzip } of result.lazy) console.log(`lazy chunk with AI SDK/zod: ${file} ${kb(gzip)} gzip`)
  if (result.leaks.length > 0) {
    for (const { file, marker } of result.leaks) console.error(`LEAK: ${file} contains ${marker}`)
    console.error('verify-chat-lazy: the AI SDK/zod reached the initial dashboard load')
    process.exit(1)
  }
  if (result.lazy.length === 0) {
    console.error('verify-chat-lazy: no chunk contains the markers; the check is vacuous')
    process.exit(1)
  }
  console.log('verify-chat-lazy: ok, AI SDK and zod load only with the chat')
}
