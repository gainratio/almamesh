/**
 * Pure helpers for the real-Safari smoke (scripts/safari-smoke.mjs). No
 * WebDriver here, so the stage/timeout/diagnostic contract is unit-tested
 * (src/lib/safariSmoke.test.ts) without a browser.
 */

/** A smoke stage that failed or timed out, with the page state at that moment. */
export class SafariSmokeStageError extends Error {
  constructor(stage, message, snapshot) {
    super(message)
    this.name = 'SafariSmokeStageError'
    this.stage = stage
    this.snapshot = snapshot
  }
}

async function readSnapshot(snapshot) {
  try {
    return await snapshot()
  } catch (error) {
    return { snapshotError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run one named stage within `timeoutMs`. On a timeout or a throw, read the
 * diagnostic snapshot and reject with a SafariSmokeStageError naming the stage.
 */
export async function runStage(stage, timeoutMs, body, snapshot) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return await Promise.race([body(), deadline])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SafariSmokeStageError(stage, message, await readSnapshot(snapshot))
  } finally {
    clearTimeout(timer)
  }
}

/** One headline naming the stage, then one JSON line a log reader can parse. */
export function formatStageFailure(error) {
  return [
    `safari-smoke FAILED at stage "${error.stage}": ${error.message}`,
    JSON.stringify({ stage: error.stage, snapshot: error.snapshot }),
  ].join('\n')
}

/**
 * The storage mode the app itself reports. The hook-free build exposes no
 * runtime global for it; it shows InMemoryStorageNotice exactly when OPFS was
 * refused and app data lives in in-memory SQLite.
 */
export function storageModeFrom({ inMemoryNotice }) {
  return inMemoryNotice ? 'memory' : 'opfs'
}

const FLAGS = { '--base-url': 'baseUrl', '--route': 'route', '--evidence': 'evidenceDir' }

/** `--base-url` reuses a running preview; without it the smoke builds and serves its own. */
export function parseSmokeArgs(argv) {
  const options = { baseUrl: null, route: '/onboarding', evidenceDir: 'safari-smoke-evidence' }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const key = FLAGS[flag]
    if (key === undefined) throw new Error(`Unknown safari-smoke argument: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    options[key] = value
  }
  return options
}
