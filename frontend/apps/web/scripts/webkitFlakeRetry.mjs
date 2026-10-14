#!/usr/bin/env node
/**
 * One retry for the one known WebKit flake, and nothing else.
 *
 * On GitHub's macOS VMs (never locally: 0 in 330 runs) WebKit's WebContent
 * process sometimes dies on a "WebCore: Worker" thread inside JavaScriptCore.
 * Two families are known (KNOWN_FLAKE.families):
 *   - jsc-execution-tier: SIGILL or SIGBUS in the interpreter/JIT (run
 *     38442783185 has two);
 *   - wasm-gc-visit: SIGSEGV whose top frame is the garbage collector visiting
 *     a Wasm GC object, JSC::JSWebAssemblyArray::visitChildren (main run
 *     38457856209).
 * The rule is to
 * rerun CI only on a known flake signature, so the macOS lane
 * (scripts/webkit-macos-lane.sh) reruns a failed test once only when BOTH:
 *
 *   (a) it failed (not timed out) with a page/context crash: Playwright's
 *       "Target page, context or browser has been closed" / "crashed" error,
 *       or the "[webkit-diagnostics] page crashed" line e2e/webkitDiagnostics.ts
 *       prints on the page's crash event; and
 *   (b) a .ips crash report captured during that test matches the signature
 *       (KNOWN_FLAKE below), each report justifying at most one retry.
 *
 * Every other failure (an assertion, a timeout, a crash with another
 * signature or no report) stays red, and when any failure is not the flake
 * nothing is retried. Playwright's own `retries` would retry everything.
 *
 *   node scripts/webkitFlakeRetry.mjs plan --suite <name> --report <json> --since <file>
 *        --reports-dir <dir>... --test-list <out.txt> --out <plan.json>
 *     exit 0: every failure is the flake; the test list names the reruns
 *     exit 1: stays red (the plan says why)
 *   node scripts/webkitFlakeRetry.mjs verify --plan <plan.json> --report <rerun json>
 *     exit 0 only when every retried test ran exactly once more and passed
 *   node scripts/webkitFlakeRetry.mjs summary <artifacts dir>   (reads its flake-retry-*.json)
 */

import { appendFileSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KNOWN_FLAKE = Object.freeze({
  process: /^com\.apple\.WebKit\.WebContent(\.|$)/,
  thread: 'WebCore: Worker',
  /** A JSC execution-tier frame: LLInt, BBQ or Wasm. */
  jscFrame: /^(jsc_llint_|llint_)|BBQ|Wasm/,
  families: Object.freeze([
    Object.freeze({ name: 'jsc-execution-tier', exceptions: ['EXC_BAD_INSTRUCTION/SIGILL', 'EXC_BAD_ACCESS/SIGBUS'], field: 'jscFrame' }),
    Object.freeze({
      name: 'wasm-gc-visit',
      exceptions: ['EXC_BAD_ACCESS/SIGSEGV'],
      field: 'topFrame',
      /** The crashing frame itself: a JSWebAssembly* member, or a Wasm type's visitChildren. */
      frame: /^JSC::(?:JSWebAssembly\w*::|(?:Wasm::)?\w*(?:Wasm|WebAssembly)\w*::visitChildren\b)/,
    }),
  ]),
})
const JSC_IMAGE = 'JavaScriptCore'
const MAX_FRAMES = 128
const CRASH_ERROR = /Target page, context or browser has been closed|Target crashed|Page crashed/i
const CRASH_EVENT = '[webkit-diagnostics] page crashed'
/** A report is written within seconds of the crash; the test fails after it. */
const CAPTURE_GRACE_MS = 5_000
const LOG_PREFIX = '[webkit-flake-retry]'

function parseBody(text) {
  const newline = text.indexOf('\n')
  if (newline === -1) return null
  try {
    return JSON.parse(text.slice(newline + 1))
  } catch {
    return null
  }
}

/** "2026-10-13 18:05:12.8854 +0000" -> epoch ms, or null. */
function parseCaptureTime(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))? ([+-])(\d\d)(\d\d)$/.exec(value ?? '')
  if (!match) return null
  const [, y, mo, d, h, mi, s, fraction = '0', sign, oh, om] = match
  const offsetMs = (sign === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om)) * 60_000
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Number(fraction.padEnd(3, '0').slice(0, 3))) - offsetMs
}

/** JIT code has no image name; JavaScriptCore's own frames are named. */
function jscOrJit(frame, images) {
  const image = images[frame.imageIndex]
  return image !== undefined && (image.name === undefined || image.name === JSC_IMAGE)
}

/** The first execution-tier symbol in the unbroken JSC/JIT run from the crashing frame. */
function leadingJscFrame(frames, images) {
  for (const frame of frames.slice(0, MAX_FRAMES)) {
    if (!jscOrJit(frame, images)) return null
    if (KNOWN_FLAKE.jscFrame.test(frame.symbol ?? '')) return frame.symbol
  }
  return null
}

/** The crashing frame's symbol when JavaScriptCore itself (not JIT code) is the image. */
function topJscFrame(frames, images) {
  const [top] = frames
  return top !== undefined && images[top.imageIndex]?.name === JSC_IMAGE ? top.symbol ?? null : null
}

/** The fields the flake signature reads from an .ips report, or null if it is not one. */
export function readIpsSignature(text) {
  const body = parseBody(text)
  if (!body || typeof body !== 'object') return null
  const thread = body.threads?.[body.faultingThread]
  if (!thread || !Array.isArray(thread.frames)) return null
  return {
    process: body.procName ?? null,
    thread: thread.name ?? null,
    exceptionType: body.exception?.type ?? null,
    signal: body.exception?.signal ?? null,
    capturedAtMs: parseCaptureTime(body.captureTime),
    jscFrame: leadingJscFrame(thread.frames, body.usedImages ?? []),
    topFrame: topJscFrame(thread.frames, body.usedImages ?? []),
  }
}

function familyMatches(family, signature) {
  const frame = signature[family.field]
  return family.exceptions.includes(`${signature.exceptionType}/${signature.signal}`)
    && frame !== null
    && (family.frame === undefined || family.frame.test(frame))
}

/** The known-flake family a signature belongs to, or null. */
export function knownFlakeFamily(signature) {
  if (!signature) return null
  const common = KNOWN_FLAKE.process.test(signature.process ?? '')
    && signature.thread === KNOWN_FLAKE.thread
    && signature.capturedAtMs !== null
  if (!common) return null
  return KNOWN_FLAKE.families.find((family) => familyMatches(family, signature))?.name ?? null
}

export function matchesKnownWebKitFlake(signature) {
  return knownFlakeFamily(signature) !== null
}

function* specsOf(suite, titles) {
  const path = suite.title ? [...titles, suite.title] : titles
  for (const spec of suite.specs ?? []) yield { spec, titles: path }
  for (const child of suite.suites ?? []) yield* specsOf(child, path)
}

/**
 * Playwright's --test-list form: "[project] › file › describe › title". The
 * JSON report's top-level suites are files; both resolve files from rootDir.
 */
function* testsOf(report) {
  for (const root of report.suites ?? []) {
    for (const { spec, titles } of specsOf({ ...root, title: '' }, [])) {
      for (const test of spec.tests ?? []) {
        yield { testId: [`[${test.projectName}]`, spec.file, ...titles, spec.title].join(' › '), test }
      }
    }
  }
}

function isCrashFailure(result) {
  const errors = [result.error, ...(result.errors ?? [])].map((error) => error?.message ?? '')
  const stderr = (result.stderr ?? []).map((chunk) => chunk.text ?? '')
  return result.status === 'failed' && (errors.some((message) => CRASH_ERROR.test(message)) || stderr.some((text) => text.includes(CRASH_EVENT)))
}

function capturedDuring(signature, result) {
  const start = Date.parse(result.startTime)
  return signature.capturedAtMs >= start && signature.capturedAtMs <= start + result.duration + CAPTURE_GRACE_MS
}

function findReport(result, candidates, claimed) {
  return candidates.find((report) => !claimed.has(report.name) && capturedDuring(report.signature, result))
}

function judge({ testId, test }, candidates, claimed) {
  if (test.results?.length !== 1) return { refused: { testId, reason: 'already retried' } }
  const [result] = test.results
  if (!isCrashFailure(result)) return { refused: { testId, reason: 'not a page crash' } }
  const report = findReport(result, candidates, claimed)
  if (!report) return { refused: { testId, reason: 'no matching .ips captured during the test' } }
  claimed.add(report.name)
  return { retry: { testId, ips: report.name, signature: report.signature } }
}

/**
 * Which failed tests to rerun once. `crashReports` are {name, text} for the
 * .ips files written since the lane started; only flake-signature ones count.
 */
export function planRetries(report, crashReports) {
  const failed = [...testsOf(report)].filter(({ test }) => test.status === 'unexpected')
  const candidates = crashReports
    .map((file) => {
      const signature = readIpsSignature(file.text)
      return { name: file.name, signature: signature && { ...signature, family: knownFlakeFamily(signature) } }
    })
    .filter((file) => file.signature?.family != null)
  const claimed = new Set()
  const judged = failed.map((entry) => judge(entry, candidates, claimed))
  const refused = judged.flatMap((entry) => (entry.refused ? [entry.refused] : []))
  if ((report.errors ?? []).length > 0) refused.push({ testId: '(run)', reason: 'global error' })
  const retries = judged.flatMap((entry) => (entry.retry ? [entry.retry] : []))
  if (failed.length === 0 && refused.length === 0) return { verdict: 'clean', retries: [], refused: [] }
  if (refused.length > 0 || retries.length === 0) return { verdict: 'red', retries: [], refused }
  return { verdict: 'retry', retries, refused: [] }
}

export function retryTestList(plan) {
  return plan.retries.map((retry) => `${retry.testId}\n`).join('')
}

/** The rerun proves itself: each retried test ran once and passed. */
export function verifyRetries(plan, rerunReport) {
  const ran = new Map([...testsOf(rerunReport)].map(({ testId, test }) => [testId, test]))
  const problems = plan.retries.flatMap(({ testId }) => {
    const test = ran.get(testId)
    if (!test) return [`${testId}: not run`]
    return test.status === 'expected' && test.results?.length === 1 ? [] : [`${testId}: ${test.status}`]
  })
  return { ok: problems.length === 0, problems }
}

export function summarizeRetryPlans(plans) {
  const total = plans.reduce((sum, plan) => sum + plan.retries.length, 0)
  const bySuite = plans.map((plan) => `${plan.suite}=${plan.retries.length}`).join(', ')
  return `${LOG_PREFIX} lane summary: ${total} known-flake ${total === 1 ? 'retry' : 'retries'} (${bySuite})`
}

function options(argv) {
  const parsed = { 'reports-dir': [] }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '')
    if (key === 'reports-dir') parsed[key].push(argv[index + 1])
    else parsed[key] = argv[index + 1]
  }
  return parsed
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** .ips files written since the lane's start marker, in the given report roots. */
function listDirectory(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function newCrashReports(dirs, sincePath) {
  const since = statSync(sincePath).mtimeMs
  return dirs.flatMap((dir) => {
    return listDirectory(dir)
      .filter((name) => name.endsWith('.ips'))
      .map((name) => join(dir, name))
      .filter((path) => { try { return statSync(path).mtimeMs > since } catch { return false } })
      .map((path) => ({ name: path.slice(path.lastIndexOf('/') + 1), text: readFileSync(path, 'utf8') }))
  })
}

function logRetry(suite, retry) {
  const { family, process, thread, exceptionType, signal, jscFrame, topFrame } = retry.signature
  console.log(`${LOG_PREFIX} ${JSON.stringify({ event: 'retry', suite, testId: retry.testId, ips: retry.ips, family, process, thread, exceptionType, signal, jscFrame, topFrame })}`)
}

function runPlan(args) {
  const plan = { suite: args.suite, ...planRetries(readJson(args.report), newCrashReports(args['reports-dir'], args.since)) }
  writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`)
  writeFileSync(args['test-list'], retryTestList(plan))
  for (const retry of plan.retries) logRetry(args.suite, retry)
  for (const refusal of plan.refused) console.log(`${LOG_PREFIX} ${JSON.stringify({ event: 'no-retry', suite: args.suite, ...refusal })}`)
  return plan.verdict === 'retry' ? 0 : 1
}

function runVerify(args) {
  const verdict = verifyRetries(readJson(args.plan), readJson(args.report))
  for (const problem of verdict.problems) console.log(`${LOG_PREFIX} retry still red: ${problem}`)
  return verdict.ok ? 0 : 1
}

/** Every suite that ran writes flake-retry-<suite>.json into the lane's artifacts. */
function runSummary(directory) {
  const names = readdirSync(directory).filter((name) => /^flake-retry-.+\.json$/.test(name)).sort()
  const plans = names.flatMap((name) => { try { return [readJson(join(directory, name))] } catch { return [] } })
  const line = summarizeRetryPlans(plans)
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  return 0
}

/** Run as a CLI however it is reached (a symlink too): a skipped CLI would exit 0, which the lane reads as "retry". */
function invokedDirectly() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (invokedDirectly()) {
  const [command, ...rest] = process.argv.slice(2)
  const commands = { plan: () => runPlan(options(rest)), verify: () => runVerify(options(rest)), summary: () => runSummary(rest[0]) }
  if (!commands[command]) { console.error(`usage: webkitFlakeRetry.mjs plan|verify|summary`); process.exit(64) }
  process.exit(commands[command]())
}
