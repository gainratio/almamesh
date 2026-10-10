/**
 * RSS of Playwright's macOS WebKit processes, read with `ps` (macOS has no
 * /proc, so scripts/processMemory.mjs cannot see them). On macOS the web
 * content, networking and GPU processes are XPC services launched by launchd,
 * not children of the test runner, so they are matched by the Playwright
 * WebKit install path instead of by process tree. The macOS WebKit lane runs
 * one worker, so every match belongs to the test that is running.
 */

const MiB = 1024 * 1024
const WEBKIT_INSTALL = /\/ms-playwright\/webkit-\d+\//
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/

/** `ps -axww -o pid=,ppid=,rss=,command=`: the arguments readWebKitProcesses runs. */
export const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,rss=,command=']

export function webkitRole(command) {
  if (/com\.apple\.WebKit\.WebContent/.test(command)) return 'web'
  if (/com\.apple\.WebKit\.Networking/.test(command)) return 'network'
  if (/com\.apple\.WebKit\.GPU/.test(command)) return 'gpu'
  return 'ui'
}

/** Playwright WebKit processes in `ps` output, with their role and RSS in bytes. */
export function parseWebKitPs(output) {
  return output.split('\n').flatMap((line) => {
    const match = PS_LINE.exec(line)
    if (match === null) return []
    const command = match[4]
    const executable = command.split(' ')[0] ?? ''
    if (!WEBKIT_INSTALL.test(executable)) return []
    return [{ pid: Number(match[1]), role: webkitRole(executable), rssBytes: Number(match[3]) * 1024 }]
  })
}

/**
 * Each role at its own peak (summed over that role's processes in one
 * sample), the peak total, and the largest single web content process.
 * Nothing measured is reported as null, never as zero.
 */
export function summarizeWebKitRss(samples) {
  const peakByRole = {}
  let peakTotal = null
  let peakSingleWeb = null
  for (const { processes } of samples) {
    const byRole = {}
    for (const { role, rssBytes } of processes) {
      byRole[role] = (byRole[role] ?? 0) + rssBytes
      if (role === 'web') peakSingleWeb = Math.max(peakSingleWeb ?? 0, rssBytes)
    }
    for (const [role, bytes] of Object.entries(byRole)) peakByRole[role] = Math.max(peakByRole[role] ?? 0, bytes)
    const total = processes.reduce((sum, { rssBytes }) => sum + rssBytes, 0)
    peakTotal = Math.max(peakTotal ?? 0, total)
  }
  const mib = (bytes) => (bytes === null ? null : Math.round(bytes / MiB))
  return {
    samples: samples.length,
    peakTotalMiB: samples.length === 0 ? null : mib(peakTotal),
    peakByRoleMiB: Object.fromEntries(Object.entries(peakByRole).map(([role, bytes]) => [role, mib(bytes)])),
    peakSingleWebMiB: mib(peakSingleWeb),
  }
}

/** One CSV row per process per sample. */
export function formatWebKitRssCsv(samples) {
  const rows = samples.flatMap(({ atMs, processes }) =>
    processes.map(({ pid, role, rssBytes }) => `${atMs},${pid},${role},${Math.round(rssBytes / MiB)}`))
  return ['at_ms,pid,role,rss_mib', ...rows].join('\n') + '\n'
}
