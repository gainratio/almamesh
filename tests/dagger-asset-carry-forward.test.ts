import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ASSET_MANIFEST_FILE,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  MAX_CARRIED_BYTES,
  MAX_CARRIED_RELEASES,
  carryForwardAssets,
  missingAssetFallbackProblems,
  parseAssetManifest,
  planCarryForward,
  type AssetEntry,
  type AssetManifest,
  type AssetRelease,
} from "../frontend/apps/web/scripts/carryForwardAssets.mjs"
import { MAX_PAGES_UPLOAD_FILE_BYTES, MAX_PAGES_UPLOAD_FILE_COUNT } from "../dagger/src/pagesUploadLimits.ts"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const asset = (name: string, body = name): AssetEntry => ({ path: `assets/${name}`, bytes: Buffer.byteLength(body), sha256: sha(body) })
const release = (id: string, ...names: string[]): AssetRelease => ({ id, assets: names.map((name) => asset(name)) })
const manifest = (...releases: AssetRelease[]): AssetManifest => ({ schema: 1, releases })

describe("deploy skew carry-forward bounds", () => {
  test("pins the documented bounds as literals", () => {
    expect(MAX_CARRIED_RELEASES).toBe(2)
    expect(MAX_CARRIED_BYTES).toBe(67_108_864) // 64 MiB
    // Same numbers as the upload-limit gate (Cloudflare Pages direct upload).
    expect(DEFAULT_MAX_FILES).toBe(20_000)
    expect(DEFAULT_MAX_FILE_BYTES).toBe(26_214_400)
    expect(DEFAULT_MAX_FILES).toBe(MAX_PAGES_UPLOAD_FILE_COUNT)
    expect(DEFAULT_MAX_FILE_BYTES).toBe(MAX_PAGES_UPLOAD_FILE_BYTES)
  })
})

describe("planCarryForward", () => {
  const own = release("c".repeat(40), "index-C.js", "shared-S.js")

  test("no previous manifest: carries nothing and lists only the new release", () => {
    const plan = planCarryForward({ own, previous: null, uploadFiles: 10 })
    expect(plan.carry).toEqual([])
    expect(plan.manifest).toEqual(manifest(own))
  })

  test("carries the previous release's files the new build lacks, newest first", () => {
    const previous = manifest(release("b", "index-B.js", "shared-S.js"), release("a", "index-A.js"))
    const plan = planCarryForward({ own, previous, uploadFiles: 10 })
    expect(plan.carry.map((entry) => entry.path)).toEqual(["assets/index-B.js", "assets/index-A.js"])
    expect(plan.manifest.releases.map((entry) => entry.id)).toEqual([own.id, "b", "a"])
    // The carried release keeps its full list (shared-S.js too) for the next deploy to carry.
    expect(plan.manifest.releases[1]).toEqual(release("b", "index-B.js", "shared-S.js"))
  })

  test("never carries more than the last two releases", () => {
    const previous = manifest(release("b", "b.js"), release("a", "a.js"), release("z", "z.js"))
    const plan = planCarryForward({ own, previous, uploadFiles: 10 })
    expect(plan.manifest.releases.map((entry) => entry.id)).toEqual([own.id, "b", "a"])
    expect(plan.carry.map((entry) => entry.path)).not.toContain("assets/z.js")
  })

  test("a carried file never replaces a new one: same path, other bytes is a conflict and the new file wins", () => {
    const previous = manifest({ id: "b", assets: [asset("shared-S.js", "OLD BYTES"), asset("index-B.js")] })
    const plan = planCarryForward({ own, previous, uploadFiles: 10 })
    expect(plan.carry.map((entry) => entry.path)).toEqual(["assets/index-B.js"])
    expect(plan.conflicts).toEqual(["assets/shared-S.js"])
    expect(plan.manifest.releases[1]?.assets.map((entry) => entry.path)).toEqual(["assets/index-B.js"])
  })

  test("between two carried releases the newer copy of a path wins", () => {
    const previous = manifest({ id: "b", assets: [asset("x.js", "B")] }, { id: "a", assets: [asset("x.js", "A")] })
    const plan = planCarryForward({ own, previous, uploadFiles: 10 })
    expect(plan.carry).toEqual([asset("x.js", "B")])
    expect(plan.conflicts).toEqual(["assets/x.js"])
  })

  test("a redeploy of the same release carries nothing new", () => {
    const plan = planCarryForward({ own, previous: manifest(own), uploadFiles: 10 })
    expect(plan.carry).toEqual([])
  })

  test("the byte cap drops whole releases, newest kept", () => {
    const big = (name: string) => ({ path: `assets/${name}`, bytes: 40, sha256: sha(name) })
    const previous = manifest({ id: "b", assets: [big("b1.js"), big("b2.js")] }, { id: "a", assets: [big("a1.js")] })
    const plan = planCarryForward({ own, previous, uploadFiles: 10, limits: { maxCarriedBytes: 100 } })
    expect(plan.carry.map((entry) => entry.path)).toEqual(["assets/b1.js", "assets/b2.js"])
    expect(plan.carriedBytes).toBe(80)
    expect(plan.dropped).toEqual(["a"])
    expect(plan.manifest.releases.map((entry) => entry.id)).toEqual([own.id, "b"])
  })

  test("a release that alone exceeds the byte cap is dropped, and so is every older one", () => {
    const previous = manifest({ id: "b", assets: [{ path: "assets/huge.js", bytes: 101, sha256: sha("h") }] }, release("a", "a.js"))
    const plan = planCarryForward({ own, previous, uploadFiles: 10, limits: { maxCarriedBytes: 100 } })
    expect(plan.carry).toEqual([])
    expect(plan.dropped).toEqual(["b"])
  })

  test("the Pages file-count limit bounds the finished upload, counting the new build's files", () => {
    const previous = manifest(release("b", "b1.js", "b2.js"), release("a", "a1.js"))
    expect(planCarryForward({ own, previous, uploadFiles: 18, limits: { maxFiles: 20 } }).carry).toHaveLength(2)
    const tight = planCarryForward({ own, previous, uploadFiles: 19, limits: { maxFiles: 20 } })
    expect(tight.carry).toEqual([])
    expect(tight.dropped).toEqual(["b"])
  })
})

describe("parseAssetManifest (the previous deployment's file is untrusted input)", () => {
  const valid = { schema: 1, releases: [{ id: "b", assets: [asset("index-B.js")] }] }

  test("accepts the exact schema", () => {
    expect(parseAssetManifest(valid)).toEqual(valid as AssetManifest)
  })

  test.each([
    ["wrong schema", { ...valid, schema: 2 }],
    ["HTML-ish value", "<!doctype html>"],
    ["path outside /assets", { schema: 1, releases: [{ id: "b", assets: [{ ...asset("x.js"), path: "index.html" }] }] }],
    ["path traversal", { schema: 1, releases: [{ id: "b", assets: [{ ...asset("x.js"), path: "assets/../_headers" }] }] }],
    ["nested path", { schema: 1, releases: [{ id: "b", assets: [{ ...asset("x.js"), path: "assets/sub/x.js" }] }] }],
    ["file over the Pages per-file limit", { schema: 1, releases: [{ id: "b", assets: [{ ...asset("x.js"), bytes: 26_214_401 }] }] }],
    ["bad digest", { schema: 1, releases: [{ id: "b", assets: [{ ...asset("x.js"), sha256: "nope" }] }] }],
    ["duplicate path", { schema: 1, releases: [{ id: "b", assets: [asset("x.js"), asset("x.js")] }] }],
    ["bad release id", { schema: 1, releases: [{ id: "has space", assets: [] }] }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseAssetManifest(value)).toThrow()
  })
})

describe("a missing chunk must stay a real 404", () => {
  const redirects = readFileSync(join(import.meta.dir, "..", "frontend", "apps", "web", "public", "_redirects"), "utf8")
  const has404 = existsSync(join(import.meta.dir, "..", "frontend", "apps", "web", "public", "404.html"))

  test("the shipped public/ has a top-level 404.html and no rewrite matching /assets/*", () => {
    expect(missingAssetFallbackProblems({ hasTopLevel404: has404, redirects })).toEqual([])
  })

  test("removing 404.html turns on Pages' SPA fallback: flagged", () => {
    expect(missingAssetFallbackProblems({ hasTopLevel404: false, redirects })).toHaveLength(1)
  })

  test.each(["/* /index.html 200", "/assets/* / 200", "/assets/:chunk /404.html 200", "/* / 200"])(
    "a catch-all rewrite (%s) is flagged",
    (rule) => {
      expect(missingAssetFallbackProblems({ hasTopLevel404: true, redirects: `${redirects}\n${rule}\n` })).toHaveLength(1)
    },
  )

  test("route rewrites that cannot match /assets/* are fine", () => {
    expect(missingAssetFallbackProblems({ hasTopLevel404: true, redirects: "/mesh/:memberId / 200\n# /* / 200\n" })).toEqual([])
  })
})

describe("carryForwardAssets (filesystem + network layer, fake fetch)", () => {
  function dist(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "carry-forward-"))
    for (const [name, body] of Object.entries({ "404.html": "nf", "_redirects": "/dashboard / 200\n", ...files })) {
      mkdirSync(join(dir, name, ".."), { recursive: true })
      writeFileSync(join(dir, name), body)
    }
    return dir
  }
  function origin(files: Record<string, string>, calls: string[] = []) {
    return async (url: URL) => {
      calls.push(url.pathname)
      const body = files[url.pathname]
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 })
    }
  }
  const previousManifest = JSON.stringify(manifest(release("b", "index-B.js", "shared-S.js")))
  const live = { "/assets-manifest.json": previousManifest, "/assets/index-B.js": "index-B.js", "/assets/shared-S.js": "shared-S.js" }

  test("downloads, verifies and adds the previous release's files, then writes the manifest", async () => {
    const dir = dist({ "assets/index-C.js": "index-C.js", "assets/shared-S.js": "shared-S.js", "build.json": JSON.stringify({ commit: "c".repeat(40) }) })
    try {
      const calls: string[] = []
      const summary = await carryForwardAssets({ distDir: dir, previousOrigin: "https://prev.almamesh.pages.dev", fetch: origin(live, calls) })
      expect(summary).toMatchObject({ previousManifest: true, ownFiles: 2, carriedFiles: 1, carriedReleases: ["b"], conflicts: [] })
      expect(readdirSync(join(dir, "assets")).sort()).toEqual(["index-B.js", "index-C.js", "shared-S.js"])
      expect(calls).not.toContain("/assets/shared-S.js") // identical bytes already in the new build
      const written = JSON.parse(readFileSync(join(dir, ASSET_MANIFEST_FILE), "utf8"))
      expect(written.releases.map((entry: AssetRelease) => entry.id)).toEqual(["c".repeat(40), "b"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a previous deployment without a manifest (first deploy of this scheme) carries nothing", async () => {
    const dir = dist({ "assets/index-C.js": "index-C.js" })
    try {
      const summary = await carryForwardAssets({ distDir: dir, previousOrigin: "https://prev.almamesh.pages.dev", fetch: origin({}) })
      expect(summary).toMatchObject({ previousManifest: false, carriedFiles: 0 })
      expect(existsSync(join(dir, ASSET_MANIFEST_FILE))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a carried file whose bytes differ from the manifest (an SPA fallback, a truncation) fails and writes nothing", async () => {
    const dir = dist({ "assets/index-C.js": "index-C.js" })
    try {
      const forged = { ...live, "/assets/index-B.js": "<!doctype html><html>app shell</html>" }
      await expect(carryForwardAssets({ distDir: dir, previousOrigin: "https://prev.almamesh.pages.dev", fetch: origin(forged) }))
        .rejects.toThrow("differs from the previous manifest")
      // Same length, other bytes: only the digest can tell.
      const sameLength = { ...live, "/assets/index-B.js": "index-B.jX" }
      await expect(carryForwardAssets({ distDir: dir, previousOrigin: "https://prev.almamesh.pages.dev", fetch: origin(sameLength) }))
        .rejects.toThrow("differs from the previous manifest")
      expect(readdirSync(join(dir, "assets"))).toEqual(["index-C.js"])
      expect(existsSync(join(dir, ASSET_MANIFEST_FILE))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a manifest answered with HTML (an SPA fallback) or a 5xx fails closed", async () => {
    const dir = dist({ "assets/index-C.js": "index-C.js" })
    try {
      await expect(carryForwardAssets({ distDir: dir, previousOrigin: "https://p.almamesh.pages.dev", fetch: origin({ "/assets-manifest.json": "<!doctype html>" }) }))
        .rejects.toThrow("not JSON")
      await expect(carryForwardAssets({ distDir: dir, previousOrigin: "https://p.almamesh.pages.dev", fetch: async () => new Response("", { status: 503 }) }))
        .rejects.toThrow("HTTP 503")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("refuses a build where a missing chunk would not 404", async () => {
    const dir = dist({ "assets/index-C.js": "index-C.js", "_redirects": "/* /index.html 200\n" })
    try {
      await expect(carryForwardAssets({ distDir: dir, previousOrigin: null })).rejects.toThrow("would not 404")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("the deploy's carry-forward command (dagger/src/assetCarryForward.ts)", () => {
  test("passes the Pages upload limits from pagesUploadLimits.ts, so the bounds cannot drift", async () => {
    const { carryForwardCommand } = await import("../dagger/src/assetCarryForward.ts")
    expect(carryForwardCommand("/release/dist", "https://abc123.almamesh.pages.dev")).toEqual([
      "node", "/tool/carryForwardAssets.mjs", "/release/dist", "https://abc123.almamesh.pages.dev",
      "--max-files", "20000", "--max-file-bytes", "26214400",
    ])
  })

  test("without a previous deployment (the dry run) it only writes the manifest", async () => {
    const { carryForwardCommand } = await import("../dagger/src/assetCarryForward.ts")
    expect(carryForwardCommand("dist", null)).toEqual([
      "node", "/tool/carryForwardAssets.mjs", "dist", "--max-files", "20000", "--max-file-bytes", "26214400",
    ])
  })

  test.each(["http://abc.almamesh.pages.dev", "https://evil.example", "https://almamesh.pages.dev.evil.example", "https://u:p@abc.almamesh.pages.dev"])(
    "refuses to fetch carried assets from %s",
    async (url) => {
      const { carryForwardCommand } = await import("../dagger/src/assetCarryForward.ts")
      expect(() => carryForwardCommand("dist", url)).toThrow("carry-forward source")
    },
  )
})
