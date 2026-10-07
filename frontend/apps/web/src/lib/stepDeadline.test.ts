import { describe, expect, it } from 'vitest'
import { DeadlineError, withDeadline } from '../../scripts/stepDeadline.mjs'

// The exit gate drives a real browser. When the page's main thread wedges,
// Playwright calls such as page.evaluate never settle; each CHECK must fail on
// its own deadline and name the step it was stuck in.
function captureLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

const ISO = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/

describe('withDeadline', () => {
  it('returns the check result and logs each step start and end with ISO time and elapsed ms', async () => {
    const { lines, log } = captureLog()
    const value = await withDeadline('CHECK 1', 1_000, async ({ step }) => {
      const a = await step('first', async () => 2)
      return a + (await step('second', async () => 3))
    }, { log })

    expect(value).toBe(5)
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line).toMatch(ISO)
      expect(line).toMatch(/\(\+\d+ms\)$/)
    }
    expect(lines[0]).toContain('CHECK 1 start')
    expect(lines[1]).toContain('CHECK 1 › first: start')
    expect(lines[2]).toMatch(/CHECK 1 › first: end in \d+ms/)
    expect(lines[5]).toContain('CHECK 1 end')
  })

  it('fails a never-resolving step on the deadline, naming the check and the step', async () => {
    const { lines, log } = captureLog()
    const started = Date.now()
    const run = withDeadline('CHECK 5', 50, async ({ step }) => {
      await step('reload /dashboard', async () => undefined)
      await step('poll engine stage', () => new Promise<never>(() => {}))
    }, { log })

    await expect(run).rejects.toBeInstanceOf(DeadlineError)
    await expect(run).rejects.toThrow('CHECK 5 timed out after 0.05s during poll engine stage')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(lines.at(-1)).toContain('CHECK 5 timed out during poll engine stage')
  })

  it('names the check start when the body hangs before its first step', async () => {
    const run = withDeadline('CHECK 7', 20, () => new Promise<never>(() => {}), { log: () => {} })
    await expect(run).rejects.toThrow('CHECK 7 timed out after 0.02s during (before first step)')
  })

  it('formats whole-second deadlines without decimals', async () => {
    const error = new DeadlineError('CHECK 4', 90_000, 'open dashboard')
    expect(error.message).toBe('CHECK 4 timed out after 90s during open dashboard')
    expect(error.check).toBe('CHECK 4')
    expect(error.step).toBe('open dashboard')
  })

  it('passes a check failure through unchanged instead of calling it a timeout', async () => {
    const boom = new Error('selector missing')
    const run = withDeadline('CHECK 2', 1_000, async ({ step }) => {
      await step('generate', async () => {
        throw boom
      })
    }, { log: () => {} })
    await expect(run).rejects.toBe(boom)
  })

  it('aborts the signal on timeout so polling loops stop, and refuses new steps', async () => {
    let signalSeen: AbortSignal | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let lateStep: Promise<unknown> | undefined
    const run = withDeadline('CHECK 1', 20, async ({ step, signal }) => {
      signalSeen = signal
      await step('wedged', () => gate)
      lateStep = step('after wedge', async () => 'ran')
      await lateStep
    }, { log: () => {} })

    await expect(run).rejects.toBeInstanceOf(DeadlineError)
    expect(signalSeen?.aborted).toBe(true)
    release()
    await expect.poll(() => lateStep !== undefined).toBe(true)
    await expect(lateStep).rejects.toBeInstanceOf(DeadlineError)
  })
})
