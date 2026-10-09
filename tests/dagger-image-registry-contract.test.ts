import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

// CI must never pull from Docker Hub: its unauthenticated pull limit failed four
// gates of run 37988010725 (`toomanyrequests`). Every image the module or the
// workflows name comes from the GHCR mirror (gainratio/ci mirror/images.json) or
// from another registry (mirror.gcr.io, ghcr.io) by digest. The TypeScript SDK's own bun introspector
// image cannot be overridden, so the engine also gets a Docker Hub mirror
// (.github/xdg/dagger/engine.json), mounted by the CLI from $XDG_CONFIG_HOME.

const root = resolve(import.meta.dir, "..")
const SCANNED_ROOTS = ["dagger", ".github"]
const SKIPPED_DIRS = new Set(["node_modules", "sdk", ".pnpm-store"])
const SKIPPED_FILES = new Set(["yarn.lock"])
const MIRROR = "ghcr.io/hseshadr/mirror/docker.io"
// Mirror root is still ghcr.io/hseshadr/... until it moves to gainratio (tracked follow-up).
const ENGINE_CONFIG = ".github/xdg/dagger/engine.json"
const XDG_CONFIG_HOME = "${{ github.workspace }}/.github/xdg"
const DAGGER_ACTION = "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77"
// The Node runtime image the TypeScript SDK v0.21.8 would pull from Docker Hub
// (sdk/typescript/runtime/tsdistconsts DefaultNodeImageRef), pinned by digest on
// Google's Docker Hub cache until the GHCR mirror can hold it.
const SDK_NODE_BASE_IMAGE =
  "mirror.gcr.io/library/node:24.13.1-alpine@sha256:4f696fbf39f383c1e486030ba6b289a5d9af541642fc78ab197e584a113b9c03"
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"])

const IMAGE_PATTERNS: readonly RegExp[] = [
  /\.from\(\s*["'`]([^"'`]+)["'`]/g,
  /\b[A-Z_]*IMAGE[A-Z_]*\s*[:=]\s*["'`]([^"'`]+)["'`]/g,
  /(?:^|\s)(?:image|container):\s*["']?([^\s"'#]+)/gm,
  /\b(?:docker|image|docker-image):\/\/([^\s"'`]+)/g,
  /"baseImage"\s*:\s*"([^"]+)"/g,
  /["'`]((?:[a-z0-9.-]+(?::\d+)?\/)*[a-z0-9._-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64})["'`]/g,
  /(?<![\w./-])((?:index\.|registry-1\.)?docker\.io\/[\w./:@-]+)/g,
]

// The places an image is chosen: a literal `.from(` argument, an image constant
// (with or without a type annotation), and the TS SDK's `dagger.baseImage`.
const PULLED_IMAGE_PATTERNS: readonly RegExp[] = [
  /\.from\(\s*["'`]([^"'`]+)["'`]/g,
  /\b[A-Z_]*IMAGE[A-Z_]*(?:\s*:\s*[\w |]+)?\s*=\s*["'`]([^"'`]+)["'`]/g,
  /"baseImage"\s*:\s*"([^"]+)"/g,
]
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/

/** Every `.from(` literal, image constant, and base image written in one file. */
export function pulledImageRefs(file: string, source: string): ImageRef[] {
  const refs = PULLED_IMAGE_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))
  return [...new Set(refs)].map((ref) => ({ file, ref }))
}

export interface ImageRef {
  readonly file: string
  readonly ref: string
}

/** The registry host an image ref resolves to; a bare `name:tag` is Docker Hub. */
export function registryOf(ref: string): string {
  const [first, ...rest] = ref.split("/")
  if (rest.length === 0) return "docker.io"
  return first.includes(".") || first.includes(":") || first === "localhost" ? first : "docker.io"
}

export function isDockerHub(ref: string): boolean {
  return DOCKER_HUB_HOSTS.has(registryOf(ref))
}

function stripYamlComments(source: string): string {
  return source.replace(/(^|\s)#.*$/gm, "$1")
}

/** Every image reference written in one file's source. */
export function imageRefs(file: string, source: string): ImageRef[] {
  const text = /\.ya?ml$/.test(file) ? stripYamlComments(source) : source
  const refs = IMAGE_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]))
  return [...new Set(refs)]
    .filter((ref) => !ref.includes("${") && /[:@]/.test(ref))
    .map((ref) => ({ file, ref }))
}

function scannedFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : scannedFiles(path)
    return SKIPPED_FILES.has(name) ? [] : [path]
  })
}

function repositoryImageRefs(): ImageRef[] {
  return SCANNED_ROOTS.flatMap((dir) => scannedFiles(resolve(root, dir)))
    .flatMap((path) => imageRefs(relative(root, path), readFileSync(path, "utf8")))
}

function repositoryPulledImageRefs(): ImageRef[] {
  return SCANNED_ROOTS.flatMap((dir) => scannedFiles(resolve(root, dir)))
    .flatMap((path) => pulledImageRefs(relative(root, path), readFileSync(path, "utf8")))
}

function daggerSteps(): Array<Record<string, unknown>> {
  const dir = resolve(root, ".github/workflows")
  return readdirSync(dir).flatMap((name) => {
    const workflow = Bun.YAML.parse(readFileSync(join(dir, name), "utf8")) as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>
    }
    return Object.values(workflow.jobs).flatMap((job) => job.steps)
      .filter((step) => step.uses === DAGGER_ACTION)
  })
}

describe("Docker Hub image classifier", () => {
  test.each([
    ["node:22-trixie-slim@sha256:" + "a".repeat(64), true],
    ["oven/bun:1.3.5", true],
    ["docker.io/library/node:24", true],
    ["index.docker.io/oven/bun:1", true],
    ["registry-1.docker.io/library/alpine:3", true],
    [`${MIRROR}/oven/bun:1.3.5@sha256:${"a".repeat(64)}`, false],
    ["ghcr.io/astral-sh/uv:0.12.1", false],
    ["public.ecr.aws/docker/library/node:24", false],
    ["localhost:5000/node:24", false],
    ["registry.dagger.io/engine:v0.21.8", false],
  ])("%s on Docker Hub: %p", (ref, expected) => {
    expect(isDockerHub(ref)).toBe(expected)
  })

  test("finds bare, docker.io, and SDK base-image refs in source", () => {
    const source = [
      'dag.container().from("alpine:3.22")',
      'const WRANGLER_IMAGE = "node:24-slim"',
      "    container: docker.io/library/python:3.13",
      '  "dagger": { "baseImage": "node:24.13.1-alpine" }',
      "uses: docker://oven/bun:1.3.0",
    ].join("\n")
    const refs = imageRefs("x.ts", source).map((image) => image.ref)
    expect(refs).toEqual(expect.arrayContaining([
      "alpine:3.22", "node:24-slim", "docker.io/library/python:3.13", "node:24.13.1-alpine", "oven/bun:1.3.0",
    ]))
    expect(refs.every(isDockerHub)).toBe(true)
  })

  test("ignores the mirror path and the engine.json registry key", () => {
    const source = `{"registries":{"docker.io":{"mirrors":["${MIRROR}"]}}}\nconst X_IMAGE = "${MIRROR}/library/node:24@sha256:${"b".repeat(64)}"`
    expect(imageRefs("engine.json", source).filter((image) => isDockerHub(image.ref))).toEqual([])
  })
})

describe("no CI path pulls from Docker Hub", () => {
  test("no image under dagger/ or .github/ resolves to Docker Hub", () => {
    const refs = repositoryImageRefs()
    // The scan must see the module's real images, or it proves nothing.
    expect(refs.length).toBeGreaterThanOrEqual(6)
    expect(refs.map((image) => image.ref)).toContain(SDK_NODE_BASE_IMAGE)
    expect(refs.filter((image) => isDockerHub(image.ref))).toEqual([])
  })

  test("every pulled image is pinned by digest", () => {
    const refs = repositoryPulledImageRefs()
    // NODE_IMAGE, PAGES_NODE_IMAGE, UV_IMAGE, BUN_IMAGE, TOOLCHAIN_IMAGE, baseImage.
    expect(refs.length).toBeGreaterThanOrEqual(6)
    expect(refs.filter((image) => !DIGEST_PINNED.test(image.ref))).toEqual([])
  })

  test.each([
    ['const NODE_IMAGE =\n  "mirror.gcr.io/library/node:22-trixie-slim"', 1],
    ['export const TOOLCHAIN_IMAGE: string | null =\n  "ghcr.io/gainratio/almamesh-toolchain:r-1"', 1],
    ['dag.container().from("alpine:3.22")', 1],
    ['"dagger": { "baseImage": "mirror.gcr.io/library/node:24" }', 1],
    [`const BUN_IMAGE = "mirror.gcr.io/oven/bun:1.3.5@sha256:${"c".repeat(64)}"`, 0],
  ])("flags an unpinned image in %s", (source, unpinned) => {
    const refs = pulledImageRefs("x.ts", source)
    expect(refs.filter((image) => !DIGEST_PINNED.test(image.ref)).length).toBe(unpinned)
  })

  test("the TypeScript SDK runtime base image is the mirror-pinned SDK default", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "dagger/package.json"), "utf8")) as {
      dagger?: { baseImage?: string }
    }
    expect(manifest.dagger?.baseImage).toBe(SDK_NODE_BASE_IMAGE)
  })

  test("the engine config mirrors Docker Hub to GHCR, then Google's cache", () => {
    const config = JSON.parse(readFileSync(resolve(root, ENGINE_CONFIG), "utf8")) as unknown
    // The GHCR mirror first; mirror.gcr.io (Google's Docker Hub cache) for anything not yet mirrored.
    expect(config).toEqual({ registries: { "docker.io": { mirrors: [MIRROR, "mirror.gcr.io"] } } })
  })

  test("every dagger-for-github step mounts that engine config", () => {
    const steps = daggerSteps()
    expect(steps.length).toBeGreaterThanOrEqual(18)
    const missing = steps.filter((step) =>
      (step.env as Record<string, string> | undefined)?.XDG_CONFIG_HOME !== XDG_CONFIG_HOME)
    expect(missing).toEqual([])
  })
})
