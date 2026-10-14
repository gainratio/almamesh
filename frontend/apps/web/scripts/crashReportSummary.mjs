#!/usr/bin/env node
/**
 * The headline of a macOS .ips crash report: which process died, how, and the
 * crashing thread's frames. The macOS WebKit lane (scripts/webkit-macos-lane.sh)
 * prints this for every report written during the run, so the job log names a
 * lost WebKit process's cause without downloading the artifact.
 *
 * The lane reports crashes and never blocks a deploy. `--signatures` redacts the
 * lane's copied reports in place (the uploaded evidence never carries the crash
 * reporter key or a UUID) and prints one GITHUB_OUTPUT line: a signature per
 * crash, keyed on thread + signal + top named frame. The workflow's
 * webkit-crash-issues job files each new key as an issue (dagger/src/webkitCrashIssues.ts).
 *
 *   node scripts/crashReportSummary.mjs <report.ips>...
 *   node scripts/crashReportSummary.mjs --lane-report <path>   (prints its label; exit 1 if not the lane's)
 *   node scripts/crashReportSummary.mjs --signatures <lane> <crash-reports dir>   (prints crashes=[...])
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** An .ips report is a JSON header line followed by a JSON body; null if it is not one. */
function parseIps(text) {
  const newline = text.indexOf('\n')
  try {
    return newline === -1 ? null : JSON.parse(text.slice(newline + 1))
  } catch {
    return null
  }
}

export function summarizeIps(text) {
  const report = parseIps(text)
  if (report === null) {
    const newline = text.indexOf('\n')
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

const SIGNATURE_FRAMES = 8
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const REPORTER_KEY = /("crashReporterKey"\s*:\s*)"[^"]*"/g

/** The report without the identifiers macOS writes into it: the crash reporter key and every UUID. */
export function redactIps(text) {
  return text.replace(REPORTER_KEY, '$1"<redacted>"').replace(UUID, '<redacted-uuid>')
}

/** A named frame: JIT frames have no symbol, and `<deduplicated_symbol>` names nothing. */
const named = (frame) => typeof frame.symbol === 'string' && !frame.symbol.startsWith('<')

/**
 * What a crash is, stable across runs: the crashing thread, the signal, and the
 * top named frame without its parameter list. Null for a report with no
 * crashing thread (a JetsamEvent, a .diag, a non-JSON file).
 */
export function crashSignature(text) {
  const report = parseIps(text)
  const thread = report?.threads?.[report.faultingThread ?? 0]
  const frames = (thread?.frames ?? []).filter(named)
  if (!report?.exception || frames.length === 0) return null
  const signal = report.exception.signal ?? report.exception.type ?? 'unknown'
  const top = frames[0].symbol.replace(/\(.*$/, '')
  const images = report.usedImages ?? []
  return {
    key: [thread.name ?? thread.queue ?? 'unnamed thread', signal, top].join(' | '),
    process: report.procName ?? 'unknown',
    exception: [report.exception.type, report.exception.signal].filter(Boolean).join(' '),
    frames: frames.slice(0, SIGNATURE_FRAMES).map((frame) => `${images[frame.imageIndex]?.name ?? '?'} ${frame.symbol}`),
  }
}

/** Redact every .ips in the lane's crash-reports directory in place; one signature per key. */
export function laneSignatures(directory, lane) {
  const signatures = new Map()
  const reports = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.ips')) : []
  for (const name of reports.sort()) {
    const path = join(directory, name)
    const text = redactIps(readFileSync(path, 'utf8'))
    writeFileSync(path, text)
    const signature = crashSignature(text)
    if (signature !== null && !signatures.has(signature.key)) signatures.set(signature.key, { ...signature, lane })
  }
  return [...signatures.values()]
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--signatures') {
  console.log(`crashes=${JSON.stringify(laneSignatures(process.argv[4] ?? '', process.argv[3] ?? ''))}`)
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--lane-report') {
  const path = process.argv[3] ?? ''
  if (!isLaneCrashReport(path)) process.exit(1)
  console.log(laneReportLabel(path))
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const path of process.argv.slice(2)) {
    console.log(`== ${path}`)
    for (const line of summarizeIps(readFileSync(path, 'utf8'))) console.log(line)
  }
}
