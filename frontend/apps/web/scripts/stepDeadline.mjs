/**
 * Per-check deadlines for the live browser gates.
 *
 * Playwright calls such as page.evaluate and context.route have no timeout of
 * their own. When the page's main thread wedges they never settle, and the
 * gate hangs until an outer watchdog kills the whole process, so the report
 * blames whatever ran next. withDeadline gives one check its own budget,
 * timestamps every step, and on expiry rejects with the check and the step
 * it was stuck in.
 */

const BEFORE_FIRST_STEP = '(before first step)'

function formatSeconds(ms) {
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)))
}

export class DeadlineError extends Error {
  constructor(check, ms, step) {
    super(`${check} timed out after ${formatSeconds(ms)}s during ${step}`)
    this.name = 'DeadlineError'
    this.check = check
    this.step = step
    this.ms = ms
  }
}

export async function withDeadline(name, ms, fn, { log = console.log } = {}) {
  const started = Date.now()
  const controller = new AbortController()
  let current = BEFORE_FIRST_STEP
  const stamp = (message) =>
    log(`[${new Date().toISOString()}] ${name} ${message} (+${Date.now() - started}ms)`)

  const step = async (label, stepFn) => {
    if (controller.signal.aborted) throw controller.signal.reason
    current = label
    const stepStarted = Date.now()
    stamp(`› ${label}: start`)
    const value = await stepFn()
    if (!controller.signal.aborted) stamp(`› ${label}: end in ${Date.now() - stepStarted}ms`)
    return value
  }

  stamp('start')
  let timer
  const work = Promise.resolve().then(() => fn({ step, signal: controller.signal }))
  // After a timeout the abandoned body may still reject; that is expected.
  work.catch(() => {})
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineError(name, ms, current)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    const value = await Promise.race([work, expired])
    stamp('end')
    return value
  } catch (error) {
    stamp(error instanceof DeadlineError ? `timed out during ${error.step}` : `failed: ${String(error)}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
