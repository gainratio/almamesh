import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  MAX_AUDIT_EXCEPTION_DAYS,
  auditIgnoreArgs,
  parseAuditExceptions,
} from "../dagger/src/auditExceptions.ts"

const REAL_FILE = resolve(import.meta.dir, "..", "security", "audit-exceptions.json")
const TODAY = new Date("2026-10-03T12:00:00Z")

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "GHSA-vfj7-8cjw-p6xm",
    cve: "CVE-2026-93687",
    package: "braces",
    vulnerableRange: "<=3.0.3",
    path: "workspace:@almamesh/web > tailwindcss > braces",
    reason: "Build-time only.",
    owner: "hseshadr",
    added: "2026-10-03",
    expires: "2027-01-01",
    ...overrides,
  }
}

function file(...entries: Record<string, unknown>[]): string {
  return JSON.stringify({ exceptions: entries })
}

describe("bun audit exception list", () => {
  test("pins the 90-day maximum the policy promises", () => {
    expect(MAX_AUDIT_EXCEPTION_DAYS).toBe(90)
  })

  test("the committed list ignores exactly the braces advisory, nothing else", () => {
    const exceptions = parseAuditExceptions(readFileSync(REAL_FILE, "utf8"), TODAY)
    expect(auditIgnoreArgs(exceptions)).toEqual(["--ignore=GHSA-vfj7-8cjw-p6xm"])
  })

  test("the committed list is still in date today (goes red on expiry)", () => {
    expect(() => parseAuditExceptions(readFileSync(REAL_FILE, "utf8"), new Date())).not.toThrow()
  })

  test("an empty list ignores nothing", () => {
    expect(auditIgnoreArgs(parseAuditExceptions(file(), TODAY))).toEqual([])
  })

  test("refuses an entry without a reason", () => {
    expect(() => parseAuditExceptions(file(entry({ reason: "  " })), TODAY)).toThrow(/reason/)
    expect(() => parseAuditExceptions(file(entry({ reason: undefined })), TODAY)).toThrow(/reason/)
  })

  test("refuses an entry without an owner or a dependency path", () => {
    expect(() => parseAuditExceptions(file(entry({ owner: "" })), TODAY)).toThrow(/owner/)
    expect(() => parseAuditExceptions(file(entry({ path: "" })), TODAY)).toThrow(/path/)
  })

  test("refuses an entry past its expiry, and accepts it on the expiry day", () => {
    const expired = file(entry({ expires: "2026-10-02" }))
    expect(() => parseAuditExceptions(expired, TODAY)).toThrow(/expired/)
    expect(() => parseAuditExceptions(file(entry({ expires: "2026-10-03" })), TODAY)).not.toThrow()
  })

  test("refuses an expiry more than 90 days after it was added", () => {
    const tooLong = file(entry({ added: "2026-10-03", expires: "2027-01-02" }))
    expect(() => parseAuditExceptions(tooLong, TODAY)).toThrow(/90 days/)
  })

  test("refuses malformed dates", () => {
    expect(() => parseAuditExceptions(file(entry({ expires: "soon" })), TODAY)).toThrow(/date/)
  })

  test("refuses ids bun cannot match, such as a CVE id or a wildcard", () => {
    expect(() => parseAuditExceptions(file(entry({ id: "CVE-2026-93687" })), TODAY)).toThrow(/GHSA/)
    expect(() => parseAuditExceptions(file(entry({ id: "GHSA-*" })), TODAY)).toThrow(/GHSA/)
  })

  test("refuses duplicate ids and a missing exceptions array", () => {
    expect(() => parseAuditExceptions(file(entry(), entry()), TODAY)).toThrow(/duplicate/)
    expect(() => parseAuditExceptions("{}", TODAY)).toThrow(/exceptions/)
  })
})
