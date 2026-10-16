import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { ENGINE_DAYS_PER_MONTH, LONG_PERIOD_WINDOW_MONTHS } from "../frontend/packages/llm/src/period.ts"

const root = resolve(import.meta.dir, "..")
const read = (path: string): string => readFileSync(resolve(root, path), "utf8")

describe("time travel: the app's view of the engine is the engine's", () => {
  test("the app's engine month and longest window are the engine's own constants", () => {
    expect(read("backend/src/almamesh/transits/timeline.py")).toContain(`_DAYS_PER_MONTH = ${ENGINE_DAYS_PER_MONTH}\n`)
    expect(read("backend/src/almamesh/predictive.py")).toContain(
      `_MAX_WINDOW_MONTHS: Final[int] = ${LONG_PERIOD_WINDOW_MONTHS}\n`,
    )
  })
})
