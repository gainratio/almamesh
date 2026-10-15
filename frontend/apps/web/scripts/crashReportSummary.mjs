#!/usr/bin/env node
/**
 * The headline of a macOS .ips crash report: which process died, how, and the
 * crashing thread's frames. The macOS WebKit lane (scripts/webkit-macos-lane.sh)
 * prints this for every report written during the run, so the job log names a
 * lost WebKit process's cause without downloading the artifact.
 *
 * The lane reports and never blocks a deploy. `--signatures` redacts the lane's
 * copied reports in place (the uploaded evidence never carries the crash
 * reporter key or a UUID) and prints one GITHUB_OUTPUT line of signatures:
 * a crash is keyed on thread + signal + top named frame; a failed test with no
 * .ips is keyed on its first unexpected error line, normalized. The workflow's
 * webkit-crash-issues job files each new key as an issue (dagger/src/webkitCrashIssues.ts).
 *
 *   node scripts/crashReportSummary.mjs <report.ips>...
 *   node scripts/crashReportSummary.mjs --lane-report <path>   (prints its label; exit 1 if not the lane's)
 *   node scripts/crashReportSummary.mjs --signatures <lane> <lane artifacts dir>   (prints crashes=[...])
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
    kind: 'crash',
    key: [thread.name ?? thread.queue ?? 'unnamed thread', signal, top].join(' | '),
    process: report.procName ?? 'unknown',
    exception: [report.exception.type, report.exception.signal].filter(Boolean).join(' '),
    frames: frames.slice(0, SIGNATURE_FRAMES).map((frame) => `${images[frame.imageIndex]?.name ?? '?'} ${frame.symbol}`),
  }
}

/** Terminal colour codes in Playwright's error text (ESC [ ... m). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const CRASH_ERROR = /Target crashed|Page crashed|Target page, context or browser has been closed/i

/** One stable line: no ANSI, no local origin, and no UUID, asset hash or long number. */
function normalizeErrorLine(line) {
  return line
    .replace(ANSI, '')
    .replace(UUID, '<uuid>')
    .replace(/blob:https?:\/\/[^/\s]+\//g, 'blob:')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/g, '')
    .replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)\b/g, '-*$1')
    .replace(/\d{3,}/g, '<n>')
    .trim()
    .slice(0, 200)
}

/** The first unexpected entry of an expect() diff (`+   "console: ..."`), else the message's first line. */
function firstErrorLine(message) {
  const lines = message.replace(ANSI, '').split('\n')
  const added = lines.find((line) => /^\s*\+\s+"/.test(line))
  if (added !== undefined) return added.replace(/^\s*\+\s+"/, '').replace(/",?\s*$/, '')
  return (lines.find((line) => line.trim() !== '') ?? 'unknown failure').trim().replace(/^Error:\s*/, '')
}

function* failedTests(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const result = (test.results ?? []).find((candidate) => candidate.status !== 'passed' && candidate.status !== 'skipped')
      if (test.status === 'unexpected' && result) yield { spec, test, message: result.errors?.[0]?.message ?? result.error?.message ?? '' }
    }
  }
  for (const child of suite.suites ?? []) yield* failedTests(child)
}

/**
 * Failed tests in the lane's Playwright JSON reports, keyed on the first
 * unexpected error line. A page crash is left to its .ips signature when the
 * lane captured one (`hasCrashReport`); without one it is filed like any failure.
 */
export function failureSignatures(reports, lane, hasCrashReport) {
  const signatures = new Map()
  for (const report of reports) {
    for (const { spec, test, message } of (report.suites ?? []).flatMap((suite) => [...failedTests(suite)])) {
      if (hasCrashReport && CRASH_ERROR.test(message)) continue
      const key = normalizeErrorLine(firstErrorLine(message))
      const where = `[${test.projectName}] ${spec.file}:${spec.line} ${spec.title}`.slice(0, 200)
      const seen = signatures.get(key)
      if (seen) { if (seen.frames.length < SIGNATURE_FRAMES) seen.frames.push(where); continue }
      signatures.set(key, { kind: 'failure', key, lane, process: 'Playwright WebKit', exception: 'test failure without a crash report', frames: [where] })
    }
  }
  return [...signatures.values()]
}

function readReports(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith('-report.json')).sort().flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(directory, name), 'utf8'))] } catch { return [] }
  })
}

/**
 * Redact every .ips under the lane's crash-reports/ in place, then return one
 * signature per key: crashes first, then failed tests that no .ips explains.
 */
export function laneSignatures(artifacts, lane) {
  const crashes = new Map()
  const directory = join(artifacts, 'crash-reports')
  const reports = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.ips')) : []
  for (const name of reports.sort()) {
    const path = join(directory, name)
    const text = redactIps(readFileSync(path, 'utf8'))
    writeFileSync(path, text)
    const signature = crashSignature(text)
    if (signature !== null && !crashes.has(signature.key)) crashes.set(signature.key, { ...signature, lane })
  }
  return [...crashes.values(), ...failureSignatures(readReports(artifacts), lane, crashes.size > 0)]
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
