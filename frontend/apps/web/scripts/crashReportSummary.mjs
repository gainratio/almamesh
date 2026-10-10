#!/usr/bin/env node
/**
 * The headline of a macOS .ips crash report: which process died, how, and the
 * crashing thread's frames. The macOS WebKit lane (scripts/webkit-macos-lane.sh)
 * prints this for every report written during the run, so the job log names a
 * lost WebKit process's cause without downloading the artifact.
 *
 *   node scripts/crashReportSummary.mjs <report.ips>...
 *   node scripts/crashReportSummary.mjs --lane-report <path>   (prints its label; exit 1 if not the lane's)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAX_FRAMES = 30
/**
 * Reports from the processes the lane runs: WebKit's (WebContent, Networking,
 * GPU), Playwright's and bun's, plus JetsamEvent, the report macOS writes when
 * it kills a process (a WebContent among them) for memory.
 */
const LANE_PROCESS = /^(com\.apple\.WebKit\.|Playwright|bun|JetsamEvent)[^/]*\.(ips|crash|diag)$/

export function isLaneCrashReport(path) {
  return LANE_PROCESS.test(path.slice(path.lastIndexOf('/') + 1))
}

/** A .diag is a resource report (CPU, wakeups, disk writes); the rest are crashes or kills. */
export function laneReportLabel(path) {
  return path.endsWith('.diag') ? 'resource report' : 'crash report'
}

function frameLine(frame, images) {
  const image = images[frame.imageIndex ?? 0]?.name ?? '?'
  const where = frame.symbol ?? `+0x${(frame.imageOffset ?? 0).toString(16)}`
  return `  ${image} ${where}`
}

/** An .ips report is a JSON header line followed by a JSON body. */
export function summarizeIps(text) {
  const newline = text.indexOf('\n')
  let report
  try {
    report = JSON.parse(text.slice(newline + 1))
  } catch {
    return [`not a JSON crash report: ${text.slice(0, newline === -1 ? 120 : Math.min(newline, 120))}`]
  }
  const { exception = {}, termination = {}, threads = [], usedImages = [], faultingThread = 0 } = report
  const thread = threads[faultingThread] ?? { frames: [] }
  return [
    `process: ${report.procName ?? '?'}`,
    `exception: ${[exception.type, exception.signal, exception.subtype].filter(Boolean).join(' ')}`,
    `termination: ${[termination.namespace, termination.indicator].filter(Boolean).join(' ')}`,
    `crashing thread ${faultingThread}: ${thread.name ?? thread.queue ?? ''}`.trimEnd(),
    ...(thread.frames ?? []).slice(0, MAX_FRAMES).map((frame) => frameLine(frame, usedImages)),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--lane-report') {
  const path = process.argv[3] ?? ''
  if (!isLaneCrashReport(path)) process.exit(1)
  console.log(laneReportLabel(path))
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const path of process.argv.slice(2)) {
    console.log(`== ${path}`)
    for (const line of summarizeIps(readFileSync(path, 'utf8'))) console.log(line)
  }
}
