/**
 * OS memory (RSS) of the browser processes a verification script launched,
 * read from Linux /proc. Used by the report-only memory samples: the one-core
 * low-end lane (verify-browser-journey.mjs) and the WebKit web-content process
 * (verify-webkit-engine.mjs). Only descendants of the given root pid count, so
 * another Playwright job on the same machine is never measured.
 *
 * On a non-Linux host readProcessTree returns null; callers report the reading
 * as unavailable instead of guessing.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'

const MiB = 1024 * 1024

/** `pid (comm) state ppid ...`; comm may hold spaces and parentheses. */
export function parseProcStat(text) {
  const close = text.lastIndexOf(')')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const ppid = Number(text.slice(close + 2).split(' ')[1])
  return { pid, ppid }
}

export function parseVmRssBytes(statusText) {
  const match = /VmRSS:\s+(\d+) kB/.exec(statusText)
  return match ? Number(match[1]) * 1024 : null
}

const CHROMIUM_TYPES = { renderer: 'renderer', 'gpu-process': 'gpu', utility: 'utility', zygote: 'zygote' }

export function processKind(argv) {
  // Chromium rewrites its child process titles, so /proc/<pid>/cmdline can be
  // one space-separated string instead of NUL-separated arguments.
  const words = argv.flatMap((argument) => argument.split(' ')).filter(Boolean)
  const executable = words[0] ?? ''
  // GTK builds name them WebKit*Process; the WPE build Playwright runs, WPE*Process.
  if (/(WebKit|WPE)WebProcess$/.test(executable)) return 'webkit-web'
  if (/(WebKit|WPE)NetworkProcess$/.test(executable)) return 'webkit-network'
  const type = words.find((word) => word.startsWith('--type='))?.slice('--type='.length)
  if (type !== undefined) return CHROMIUM_TYPES[type] ?? 'other'
  return /chrom(e|ium)|headless_shell|MiniBrowser/.test(executable) ? 'browser' : 'other'
}

export function descendantPids(rootPid, parents) {
  const children = new Map()
  for (const [pid, ppid] of parents) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const found = []
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    found.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return found
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null // the process exited between listing and reading
  }
}

/** Every live descendant of rootPid with its kind and RSS, or null off Linux. */
export function readProcessTree(rootPid = process.pid, procRoot = '/proc') {
  if (procRoot === '/proc' && process.platform !== 'linux') return null
  let names
  try {
    names = readdirSync(procRoot)
  } catch {
    return null
  }
  const parents = new Map()
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const stat = readOrNull(join(procRoot, name, 'stat'))
    if (stat !== null) parents.set(Number(name), parseProcStat(stat).ppid)
  }
  return descendantPids(rootPid, parents).sort((a, b) => a - b).flatMap((pid) => {
    const rssBytes = parseVmRssBytes(readOrNull(join(procRoot, String(pid), 'status')) ?? '')
    if (rssBytes === null) return []
    const argv = (readOrNull(join(procRoot, String(pid), 'cmdline')) ?? '').split('\0').filter(Boolean)
    return [{ pid, kind: processKind(argv), rssBytes }]
  })
}

export function summarizeProcessTree(entries) {
  const byKind = {}
  for (const { kind, rssBytes } of entries) byKind[kind] = (byKind[kind] ?? 0) + rssBytes / MiB
  const totalMiB = entries.reduce((sum, { rssBytes }) => sum + rssBytes, 0) / MiB
  return { totalMiB, byKind, processes: entries.length }
}

/**
 * Sample the tree every intervalMs until stop(); returns the peak total and
 * the peak of each kind (each kind's own peak, not its value at the total's
 * peak), or null when /proc is unavailable.
 */
export function sampleProcessTreePeak(intervalMs = 500, rootPid = process.pid, procRoot = '/proc') {
  if (readProcessTree(rootPid, procRoot) === null) return { stop: async () => null }
  let peak = { totalMiB: 0, byKind: {}, processes: 0, samples: 0 }
  const take = () => {
    const now = summarizeProcessTree(readProcessTree(rootPid, procRoot) ?? [])
    const byKind = { ...peak.byKind }
    for (const [kind, mib] of Object.entries(now.byKind)) byKind[kind] = Math.max(byKind[kind] ?? 0, mib)
    peak = {
      totalMiB: Math.max(peak.totalMiB, now.totalMiB),
      byKind,
      processes: Math.max(peak.processes, now.processes),
      samples: peak.samples + 1,
    }
  }
  take()
  const timer = setInterval(take, intervalMs)
  return {
    stop: async () => {
      clearInterval(timer)
      take()
      return peak
    },
  }
}

/**
 * One greppable line for a report-only sample: `memory-report <lane> {json}`.
 * Numbers are rounded to whole MiB; null means "not measurable here" and
 * travels with a `reason`.
 */
export function formatMemoryReport(lane, fields) {
  const rounded = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, typeof value === 'number' ? Math.round(value) : value]),
  )
  return `memory-report ${lane} ${JSON.stringify(rounded)}`
}

/** Report fields for a process-tree peak: the total and each requested kind. */
export function processTreeReport(peak, kinds) {
  if (peak === null) return { totalRssPeakMiB: null, reason: 'no /proc on this host (RSS is read on Linux only)' }
  const fields = { totalRssPeakMiB: peak.totalMiB }
  for (const kind of kinds) fields[`${kind}RssPeakMiB`] = peak.byKind[kind] ?? null
  return { ...fields, processes: peak.processes, samples: peak.samples }
}
