import { describe, expect, test } from "bun:test"
import {
  MAX_PAGES_UPLOAD_FILE_BYTES,
  MAX_PAGES_UPLOAD_FILE_COUNT,
  assertPagesUploadLimits,
  pagesUploadLimitsCheckScript,
  type PagesUploadEntry,
} from "../dagger/src/pagesUploadLimits.ts"

function entries(count: number, bytes = 1_024): PagesUploadEntry[] {
  return Array.from({ length: count }, (_, index) => ({ path: `asset-${index}.bin`, bytes }))
}

describe("Cloudflare Pages direct-upload limits", () => {
  test("pins the exact Cloudflare Pages direct-upload bounds", () => {
    // https://developers.cloudflare.com/pages/platform/limits/ — 25 MiB per file,
    // 20,000 files per deployment. Pinned against the literal numbers, not just
    // against themselves, so a drifted constant fails loudly.
    expect(MAX_PAGES_UPLOAD_FILE_BYTES).toBe(26_214_400)
    expect(MAX_PAGES_UPLOAD_FILE_COUNT).toBe(20_000)
  })

  test("accepts a normal small build", () => {
    expect(() => assertPagesUploadLimits(entries(3, 2_048))).not.toThrow()
  })

  test("accepts an empty build", () => {
    expect(() => assertPagesUploadLimits([])).not.toThrow()
  })

  test("accepts a file at exactly the per-file byte ceiling", () => {
    const atCeiling: PagesUploadEntry[] = [
      { path: "assets/app.wasm", bytes: MAX_PAGES_UPLOAD_FILE_BYTES },
    ]
    expect(() => assertPagesUploadLimits(atCeiling)).not.toThrow()
  })

  test("rejects a file one byte over the per-file ceiling, naming the offender", () => {
    const oversize: PagesUploadEntry[] = [
      {
        path: "assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm",
        bytes: MAX_PAGES_UPLOAD_FILE_BYTES + 1,
      },
    ]
    expect(() => assertPagesUploadLimits(oversize)).toThrow(
      /ort-wasm-simd-threaded\.asyncify-CxOG5pUO\.wasm/,
    )
  })

  test("reports every oversize file, not just the first", () => {
    const big = MAX_PAGES_UPLOAD_FILE_BYTES + 1
    const oversized: PagesUploadEntry[] = [
      { path: "a.wasm", bytes: big },
      { path: "b.wasm", bytes: big },
    ]
    try {
      assertPagesUploadLimits(oversized)
      throw new Error("expected assertPagesUploadLimits to throw")
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("a.wasm")
      expect(message).toContain("b.wasm")
    }
  })

  test("accepts exactly the file-count ceiling", () => {
    expect(() => assertPagesUploadLimits(entries(MAX_PAGES_UPLOAD_FILE_COUNT))).not.toThrow()
  })

  test("rejects one file over the count ceiling, naming the actual count", () => {
    const overCount = MAX_PAGES_UPLOAD_FILE_COUNT + 1
    expect(() => assertPagesUploadLimits(entries(overCount))).toThrow(
      new RegExp(String(overCount)),
    )
  })
})

describe("in-container Cloudflare Pages upload check", () => {
  test("embeds the exact byte and count ceilings so the container check cannot drift", () => {
    const script = pagesUploadLimitsCheckScript("dist")
    expect(script).toContain(String(MAX_PAGES_UPLOAD_FILE_BYTES))
    expect(script).toContain(String(MAX_PAGES_UPLOAD_FILE_COUNT))
  })

  test("walks the directory it is given", () => {
    expect(pagesUploadLimitsCheckScript("dist")).toContain('"dist"')
    expect(pagesUploadLimitsCheckScript("dist-verify")).toContain('"dist-verify"')
  })

  test("exits non-zero and reports the failure on either violation", () => {
    const script = pagesUploadLimitsCheckScript("dist")
    expect(script).toContain("process.exit(1)")
  })
})
