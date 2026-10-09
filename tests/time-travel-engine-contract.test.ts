import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { COVERED_EVENTS } from "../frontend/packages/llm/src/period-transits.ts"
import { ENGINE_DAYS_PER_MONTH, LONG_PERIOD_WINDOW_MONTHS } from "../frontend/packages/llm/src/period.ts"

const root = resolve(import.meta.dir, "..")
const read = (path: string): string => readFileSync(resolve(root, path), "utf8")

interface GoldenEvent {
  readonly kind: string
  readonly graha: string | null
}

/** The covered_events token an engine timeline event belongs to. */
function token(event: GoldenEvent): string {
  if (event.kind === "sign_ingress") return `${event.graha}_ingress`
  if (event.kind === "station") return `${event.graha}_station`
  return event.kind
}

describe("time travel: the app's view of the engine is the engine's", () => {
  test("the app's engine month and longest window are the engine's own constants", () => {
    expect(read("backend/src/almamesh/transits/timeline.py")).toContain(`_DAYS_PER_MONTH = ${ENGINE_DAYS_PER_MONTH}\n`)
    expect(read("backend/src/almamesh/predictive.py")).toContain(
      `_MAX_WINDOW_MONTHS: Final[int] = ${LONG_PERIOD_WINDOW_MONTHS}\n`,
    )
  })

  test("covered_events names every kind the two-year golden holds, and every graha kind is really produced", () => {
    const golden = JSON.parse(read("backend/tests/fixtures/predictive_golden_de421.json"))
    const events: GoldenEvent[] = golden["1990-01-15T12:00:00+00:00@24m"].transit_context.timeline.events
    const produced = new Set(events.map(token))
    for (const kind of produced) expect(COVERED_EVENTS as readonly string[]).toContain(kind)
    const grahaKinds = COVERED_EVENTS.filter((kind) => kind.endsWith("_ingress") || kind.endsWith("_station"))
    for (const kind of grahaKinds) expect(produced.has(kind)).toBe(true)
  })
})
