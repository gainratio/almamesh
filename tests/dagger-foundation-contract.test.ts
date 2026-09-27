import { describe, expect, mock, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const centralSha = "9d491851fc5c65ad4a388ed2dd7bb4def4e1f007"
const repository = "hseshadr/almamesh"
const providerMarkers = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "withSecretVariable",
  "pages deploy",
  "api.cloudflare.com",
]

function isProviderFree(source: string): boolean {
  return providerMarkers.every((marker) => !source.includes(marker))
}

function hasFailClosedCleanup(source: string): boolean {
  return ["trap cleanup EXIT", 'kill -TERM "$pid"', 'kill -KILL "$pid"', "if ! stop_server"].every(
    (marker) => source.includes(marker),
  )
}

describe("central Dagger Lego pins", () => {
  test("pins Foundation and Cloudflare Pages to one exact central commit", () => {
    const descriptor = JSON.parse(
      readFileSync(resolve(root, "dagger.json"), "utf8"),
    ) as { dependencies?: Array<Record<string, string>> }

    expect(descriptor.dependencies).toEqual([
      {
        name: "cloudflare-pages",
        source: `github.com/hseshadr/ci/modules/cloudflare-pages@${centralSha}`,
        pin: centralSha,
      },
      {
        name: "foundation",
        source: `github.com/hseshadr/ci/modules/portfolio-foundation@${centralSha}`,
        pin: centralSha,
      },
    ])
  })

  test("binds production evidence to the exact central producer commit", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")

    expect(source).toContain(`const CENTRAL_MODULE_SHA = "${centralSha}"`)
  })

  test("keeps the shared Foundation guard as the only secret scanner", () => {
    expect(existsSync(resolve(root, "dagger/scripts/secret-scan.sh"))).toBe(false)
  })

  test("isolates the executable Pages proof from the legacy frontend runtime", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const bunBase = source.slice(
      source.indexOf("private bunBase()"),
      source.indexOf("private pagesFunctionsBuildArgs()"),
    )
    const pagesBase = source.slice(
      source.indexOf("private pagesFunctionsBase()"),
      source.indexOf("private pagesFunctionsBuild("),
    )

    expect(source).toContain(
      '"node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff"',
    )
    expect(pagesBase).toContain('.container({ platform: "linux/amd64" as Platform })')
    expect(pagesBase).toContain('`wrangler@${WRANGLER_VERSION}`')
    expect(source).not.toContain("WRANGLER_NODE")
    expect(bunBase).toContain("node-gyp nodejs poppler-utils")
    expect(bunBase).not.toContain("NODE_IMAGE")
  })

  test("keeps the closed Pages proof local, fixed, and credential-free", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const buildArgs = source.slice(
      source.indexOf("private pagesFunctionsBuildArgs()"),
      source.indexOf("private pagesFunctionsBase()"),
    )
    const build = source.slice(
      source.indexOf("private pagesFunctionsBuild("),
      source.indexOf("private uvBase()"),
    )
    const dryRun = source.slice(
      source.indexOf("deployDryRun(expectedSha: string)"),
      source.indexOf("  @func()\n  async deploy(", source.indexOf("deployDryRun(expectedSha: string)")),
    )
    const proofSetup = source.slice(
      source.indexOf("private pagesFunctionsProof("),
      source.indexOf("private providerDeploy("),
    )
    const dryRunScript = source.slice(
      source.indexOf("private pagesFunctionsDryRunScript()"),
      source.indexOf("private indexNowScript("),
    )
    const contracts = source.slice(
      source.indexOf("async contracts(): Promise<Container>"),
      source.indexOf("  @func()\n  backend()"),
    )

    const fixedArgv = [
      '"wrangler"',
      '"pages"',
      '"functions"',
      '"build"',
      '"functions"',
      '"--outfile=/derived/_worker.js"',
      '"--output-routes-path=/derived/_routes.json"',
      '"--project-directory=/project"',
      '"--build-output-directory=/project/dist"',
      '"--metafile=/derived/_build-metadata.json"',
    ]
    let previous = -1
    for (const argument of fixedArgv) {
      const index = buildArgs.indexOf(argument, previous + 1)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
    expect(build).toContain('roots.withNewDirectory(".wrangler")')
    expect(build).toContain('.withMountedDirectory("/project", closedRoots, { readOnly: true })')
    expect(build).toContain('.withMountedTemp("/project/.wrangler")')
    expect(build).not.toContain('.withMountedTemp("/project/.wrangler/tmp")')
    for (const authenticatedRoot of ["/project/dist", "/project/functions"]) {
      expect(build).not.toContain(`.withMountedTemp("${authenticatedRoot}")`)
      expect(build).not.toContain(`.withMountedDirectory("${authenticatedRoot}"`)
    }
    expect(dryRun).toContain("return this.pagesFunctionsProof(roots, expectedSha)")
    expect(proofSetup).toContain('.withFile("_worker.js", derived.file("_worker.js"))')
    expect(proofSetup).toContain('.withFile("_routes.json", derived.file("_routes.json"))')
    expect(proofSetup).toContain('.withFile("/compiled/_worker.js", staged.file("_worker.js"))')
    expect(proofSetup).toContain('.withFile("/compiled/_routes.json", staged.file("_routes.json"))')
    expect(proofSetup).toContain(
      '.withFile("/compiled/_build-metadata.json", derived.file("_build-metadata.json"))',
    )
    expect(dryRunScript).toContain("wrangler pages dev dist")
    expect(dryRunScript).not.toContain("pages dev /site")
    expect(dryRunScript).not.toContain("curl")
    expect(dryRunScript).toContain('fetch("http://127.0.0.1:8788/build.json"')
    expect(dryRunScript).toContain('fetch("http://127.0.0.1:8788/bundle/latest"')
    expect(dryRunScript).toContain('fetch("http://127.0.0.1:8788/api/feedback"')
    expect(dryRunScript).toContain('response.status!==400')
    expect(dryRunScript).toContain("JSON.stringify(body)!==JSON.stringify({ok:false,error:\"invalid_page\"})")
    expect(dryRunScript).toContain('kill -KILL "$pid"')
    expect(contracts).toContain("async contracts(): Promise<Container>")
    expect(contracts).toContain("await this.deployDryRun(CONTRACT_SHA).sync()")
    expect(contracts).toContain(".from(BUN_IMAGE)")
    expect(contracts).not.toContain("dagger call deploy --help")
    expect(contracts).not.toContain("verify-deploy-help")
    expect(contracts).not.toContain('.withFile("/usr/local/bin/bun", bun)')
    expect(contracts.indexOf("await this.deployDryRun(CONTRACT_SHA).sync()")).toBeLessThan(
      contracts.indexOf(".from(BUN_IMAGE)"),
    )

    const proof = `${dryRun}\n${dryRunScript}`
    expect(isProviderFree(proof)).toBe(true)
    expect(hasFailClosedCleanup(dryRunScript)).toBe(true)
    for (const marker of providerMarkers) {
      expect(isProviderFree(`${proof}\n${marker}`)).toBe(false)
    }
    for (const marker of [
      "trap cleanup EXIT",
      'kill -TERM "$pid"',
      'kill -KILL "$pid"',
      "if ! stop_server",
    ]) {
      expect(hasFailClosedCleanup(dryRunScript.replace(marker, ""))).toBe(false)
    }
  })

  test("runs the bounded nonfatal IndexNow notification strictly after live proof", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const released = source.slice(
      source.indexOf("private async verifyReleased("),
      source.indexOf("private signedBuild("),
    )
    const live = released.indexOf("this.verifyLive(")
    const notification = released.indexOf(
      '.withExec(["bash", "-c", this.indexNowScript("/artifact")])',
    )

    expect(live).toBeGreaterThan(-1)
    expect(notification).toBeGreaterThan(live)
    expect(released).not.toContain("curl")
    expect(source).toContain("return releaseIndexNowScript(artifact)")
  })
})

describe("Foundation guard composition", () => {
  test("binds the exact source identity and propagates a guard failure", async () => {
    const source = { identity: "workspace-source", file: () => ({}) }
    const commitSha = "1".repeat(40)
    const guardFailure = new Error("central guard rejected source")
    const guardCalls: unknown[] = []
    const orchestration: string[] = []
    const productGates: string[] = []
    const foundationGate = new Proxy(
      {
        sync: async () => {
          throw guardFailure
        },
      },
      {
        get: (target, property) =>
          property in target
            ? target[property as keyof typeof target]
            : () => foundationGate,
      },
    )

    const legacyGate = new Proxy(
      { sync: async () => undefined },
      {
        get: (target, property) =>
          property in target
            ? target[property as keyof typeof target]
            : () => legacyGate,
      },
    )
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
      dag: {
        cacheVolume: () => ({}),
        container: () => legacyGate,
        foundation: () => ({
          guard: (guardSource: unknown, guardRepository: string, guardCommitSha: string) => {
            orchestration.push("foundation")
            guardCalls.push({
              source: guardSource,
              repository: guardRepository,
              commitSha: guardCommitSha,
            })
            return foundationGate
          },
        }),
      },
    }))

    const { AlmameshCi } = await import("../dagger/src/index.ts")
    const module = new AlmameshCi({ directory: () => source } as never)
    Object.assign(module, {
      contracts: () => ({
        sync: async () => {
          orchestration.push("contracts")
        },
      }),
    })
    for (const gate of ["backend", "frontend", "browser", "pdf", "privacy"] as const) {
      module[gate] = (() => ({
        sync: async () => {
          productGates.push(gate)
        },
      })) as never
    }

    await expect(module.ci(commitSha)).rejects.toBe(guardFailure)
    expect(orchestration).toEqual(["contracts", "foundation"])
    expect(guardCalls).toEqual([{ source, repository, commitSha }])
    expect(productGates).toEqual([])
  })
})
