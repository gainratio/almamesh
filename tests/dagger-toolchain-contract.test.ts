import { describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  TOOLCHAIN_IMAGE,
  TOOLCHAIN_RECIPE,
  playwrightVersion,
  pinnedToolchain,
  recipeTag,
  toolchainImageOwner,
  toolchainPull,
  toolchainRepository,
  toolchainTag,
} from "../dagger/src/toolchain.ts"

const root = resolve(import.meta.dir, "..")
const lock = readFileSync(resolve(root, "frontend/bun.lock"), "utf8")
const workflowPath = resolve(root, ".github/workflows/toolchain-image.yml")
const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
const daggerAction = "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77"
const digest = `sha256:${"a".repeat(64)}`
const TOOLCHAIN_REPOSITORY = toolchainRepository("gainratio")
// The image toolchain-image.yml published under gainratio (run 37693260483). The
// package is private, so the gates pull it with the run's GITHUB_TOKEN.
const COMMITTED_PIN =
  "ghcr.io/gainratio/almamesh-toolchain:r-81e517e120c27dea-pw1.63.0@sha256:11352b6f77703c45c8b3e17e669a48364d422cfd421aa3281050b69f17c2cfd2"

describe("prebuilt toolchain image", () => {
  test("reads the exact Playwright version the frontend lock resolves", () => {
    expect(playwrightVersion(lock)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(playwrightVersion('"playwright-core": ["playwright-core@1.63.0", ""')).toBe("1.63.0")
  })

  test("refuses a lock with no Playwright, instead of building an image without browsers", () => {
    expect(() => playwrightVersion('"vite": ["vite@8.3.2", ""')).toThrow("playwright-core")
  })

  test("the tag names the recipe and the Playwright version", () => {
    expect(toolchainTag(TOOLCHAIN_RECIPE, "1.63.0")).toBe(`${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0`)
    expect(recipeTag(TOOLCHAIN_RECIPE)).toMatch(/^r-[0-9a-f]{16}$/)
  })

  test("any recipe change changes the tag, so a stale image is never mistaken for the new recipe", () => {
    const base = recipeTag(TOOLCHAIN_RECIPE)
    expect(recipeTag({ ...TOOLCHAIN_RECIPE, apt: [...TOOLCHAIN_RECIPE.apt, "jq"] })).not.toBe(base)
    expect(recipeTag({ ...TOOLCHAIN_RECIPE, base: "debian:13" })).not.toBe(base)
    expect(recipeTag({ ...TOOLCHAIN_RECIPE, browsers: ["chromium"] })).not.toBe(base)
  })

  test("the recipe preinstalls every browser the gates launch", () => {
    expect([...TOOLCHAIN_RECIPE.browsers].sort()).toEqual(["chromium", "firefox", "webkit"])
  })

  test("uses a digest-pinned image built from the current recipe", () => {
    const image = `${TOOLCHAIN_REPOSITORY}:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@${digest}`
    expect(pinnedToolchain(image, TOOLCHAIN_RECIPE)).toBe(image)
  })

  // The image follows the repository across the hseshadr -> gainratio transfer: a pin
  // under either owner is used, any other owner is refused (never pulled).
  test.each(["hseshadr", "gainratio"])("uses a pinned image under the %s owner", (owner) => {
    const image = `${toolchainRepository(owner)}:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@${digest}`
    expect(image).toStartWith(`ghcr.io/${owner}/almamesh-toolchain:`)
    expect(pinnedToolchain(image, TOOLCHAIN_RECIPE)).toBe(image)
  })

  test.each([
    ["another owner", "attacker"],
    ["a look-alike owner", "gainratio-evil"],
    ["an owner prefix", "hseshadrx"],
  ])("refuses a pinned image under %s", (_name, owner) => {
    const image = `ghcr.io/${owner}/almamesh-toolchain:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@${digest}`
    expect(() => pinnedToolchain(image, TOOLCHAIN_RECIPE)).toThrow("digest-pinned")
  })

  test.each(["attacker", "", "HSESHADR"])("refuses to name a toolchain repository for owner %p", (owner) => {
    expect(() => toolchainRepository(owner)).toThrow("not an allowed owner")
  })

  test.each([
    ["hseshadr/almamesh", "hseshadr", "hseshadr"],
    ["gainratio/almamesh", "gainratio", "gainratio"],
    ["gainratio/almamesh", "GainRatio", "gainratio"],
  ])("publishes %s under the lowercased run owner", (repository, owner, expected) => {
    expect(toolchainImageOwner(repository, owner)).toBe(expected)
  })

  test.each([
    ["a foreign repository", "attacker/almamesh", "attacker"],
    ["a missing repository", undefined, "hseshadr"],
    ["a missing owner", "hseshadr/almamesh", undefined],
    ["an owner that is not the repository's", "hseshadr/almamesh", "gainratio"],
  ])("refuses to publish for %s", (_name, repository, owner) => {
    expect(() => toolchainImageOwner(repository as never, owner as never)).toThrow()
  })

  test("falls back to the inline install when no image is pinned", () => {
    expect(pinnedToolchain(null, TOOLCHAIN_RECIPE)).toBeNull()
  })

  test("falls back when the pinned image was built from another recipe", () => {
    const stale = `${TOOLCHAIN_REPOSITORY}:r-0000000000000000-pw1.63.0@${digest}`
    expect(pinnedToolchain(stale, TOOLCHAIN_RECIPE)).toBeNull()
  })

  test.each([
    ["a tag without a digest", `${TOOLCHAIN_REPOSITORY}:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0`],
    ["another registry", `docker.io/hseshadr/almamesh-toolchain:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@${digest}`],
    ["a short digest", `${TOOLCHAIN_REPOSITORY}:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@sha256:abc`],
  ])("rejects %s", (_name, image) => {
    expect(() => pinnedToolchain(image, TOOLCHAIN_RECIPE)).toThrow("digest-pinned")
  })

  test("the committed pin is absent or a digest-pinned image of the current recipe", () => {
    if (TOOLCHAIN_IMAGE === null) return
    expect(pinnedToolchain(TOOLCHAIN_IMAGE, TOOLCHAIN_RECIPE)).toBe(TOOLCHAIN_IMAGE)
  })

  test("the committed pin is the gainratio-published digest", () => {
    expect(TOOLCHAIN_IMAGE).toBe(COMMITTED_PIN)
  })
})

describe("private toolchain pull", () => {
  const token = { secret: "registry-token" }

  test("pulls the pinned image from ghcr.io as its owner with the run's token", () => {
    expect(toolchainPull(COMMITTED_PIN, TOOLCHAIN_RECIPE, token)).toEqual({
      image: COMMITTED_PIN,
      registry: "ghcr.io",
      username: "gainratio",
      token,
    })
  })

  test("authenticates as the pin's own owner, never another", () => {
    const image = `${toolchainRepository("hseshadr")}:${recipeTag(TOOLCHAIN_RECIPE)}-pw1.63.0@${digest}`
    expect(toolchainPull(image, TOOLCHAIN_RECIPE, token)?.username).toBe("hseshadr")
  })

  // Local `dagger call` and runs without packages:read have no token: the
  // private image cannot be pulled, so they install inline instead of failing.
  test("without a token it installs inline instead of an unauthenticated pull", () => {
    expect(toolchainPull(COMMITTED_PIN, TOOLCHAIN_RECIPE, undefined)).toBeNull()
  })

  test("a pin from another recipe installs inline even with a token", () => {
    const stale = `${TOOLCHAIN_REPOSITORY}:r-${"0".repeat(16)}-pw1.63.0@${digest}`
    expect(toolchainPull(stale, TOOLCHAIN_RECIPE, token)).toBeNull()
    expect(toolchainPull(null, TOOLCHAIN_RECIPE, token)).toBeNull()
  })
})

// Behaviour of the real module against a recording `dag`: the browser image must
// be pulled through withRegistryAuth (a Dagger Secret, never a plain string).
describe("browser image pull in the Dagger module", () => {
  async function browserImageCalls(registryToken?: unknown): Promise<unknown[][]> {
    const calls: unknown[][] = []
    const container: Record<string, (...args: unknown[]) => unknown> = new Proxy({}, {
      get: (_target, name: string) => (...args: unknown[]) => {
        calls.push([name, ...args])
        return name === "file" ? "bun-file" : container
      },
    })
    const noOpDecorator = () => () => undefined
    mock.module("@dagger.io/dagger", () => ({
      CacheVolume: class {},
      Container: class {},
      Directory: class {},
      ReturnType: { Any: "ANY", Success: "SUCCESS" },
      Secret: class {},
      Service: class {},
      Workspace: class {},
      check: noOpDecorator,
      func: noOpDecorator,
      object: noOpDecorator,
      dag: { container: () => container, cacheVolume: () => ({}) },
    }))
    const { AlmameshCi } = await import("../dagger/src/index.ts")
    const module = new AlmameshCi({ directory: () => ({}) } as never, registryToken as never) as unknown as {
      browserImage: () => unknown
    }
    module.browserImage()
    return calls
  }

  test("authenticates to ghcr.io with the token, then pulls the pinned digest", async () => {
    const token = { secret: "registry-token" }
    expect(await browserImageCalls(token)).toEqual([
      ["withRegistryAuth", "ghcr.io", "gainratio", token],
      ["from", COMMITTED_PIN],
    ])
  })

  test("without a token never pulls the private pin and installs inline", async () => {
    const calls = await browserImageCalls()
    expect(calls.some(([name]) => name === "withRegistryAuth")).toBe(false)
    expect(calls.filter(([name]) => name === "from").map(([, image]) => image))
      .toEqual([TOOLCHAIN_RECIPE.bun, TOOLCHAIN_RECIPE.base])
  })
})

describe("toolchain image workflow", () => {
  test("publishes only from main through the Dagger module, with packages:write on that job alone", () => {
    const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as Record<string, unknown>
    expect(workflow).toEqual({
      name: "Toolchain image",
      on: {
        push: {
          branches: ["main"],
          paths: ["dagger/src/toolchain.ts", "frontend/bun.lock", ".github/workflows/toolchain-image.yml"],
        },
        workflow_dispatch: null,
      },
      permissions: { contents: "read" },
      concurrency: { group: "toolchain-image", "cancel-in-progress": false },
      jobs: {
        publish: {
          name: "Publish toolchain image",
          if: "github.ref == 'refs/heads/main'",
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 30,
          permissions: { contents: "read", packages: "write" },
          steps: [
            {
              uses: checkout,
              with: { "fetch-depth": 0, "persist-credentials": false, ref: "${{ github.sha }}" },
            },
            {
              uses: daggerAction,
              env: { GITHUB_TOKEN: "${{ github.token }}" },
              with: {
                version: "0.21.8",
                call: "publish-toolchain --github-token=env:GITHUB_TOKEN"
                  + " --repository=${{ github.repository }} --repository-owner=${{ github.repository_owner }}",
              },
            },
          ],
        },
      },
    })
  })
})

describe("deploy live smoke", () => {
  // deploy.yml's job token already reaches `deploy` as --github-token (with
  // packages:read); the live smoke's browser image is pulled with that Secret.
  test("reuses the deploy's GitHub token as the registry token", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const deploy = source.slice(source.indexOf("  async deploy("), source.indexOf("const result = await deliverProduction"))
    expect(deploy).toContain("this.registryToken ??= githubToken")
  })
})
