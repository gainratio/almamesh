import { PRODUCT_GATES } from "../dagger/src/gates.ts"
import { describe, expect, mock, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const centralSha = "4d48302e30d3a54ec71364d43aada5c0d4b1f9bf"
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
    for (const gate of PRODUCT_GATES) {
      module[gate] = (() => ({
        sync: async () => {
          productGates.push(gate)
        },
      })) as never
    }

    await expect(module.ci(commitSha)).rejects.toBe(guardFailure)
    // Contracts now start alongside the guard (they used to run strictly before
    // it), so order is not part of the contract: both run, product gates never do.
    expect([...orchestration].sort()).toEqual(["contracts", "foundation"])
    expect(guardCalls).toEqual([{ source, repository, commitSha }])
    expect(productGates).toEqual([])
  })
})

describe("ci runs independent gates concurrently", () => {
  async function ciModule(gates: Record<string, () => Promise<void>>) {
    const noOpDecorator = () => () => undefined
    const inert: unknown = new Proxy({}, { get: () => () => inert })
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
      dag: { cacheVolume: () => ({}), container: () => inert },
    }))
    const { AlmameshCi } = await import("../dagger/src/index.ts")
    const module = new AlmameshCi({ directory: () => ({}) } as never)
    const stub = (run: () => Promise<void>) => () => ({ sync: run })
    Object.assign(module, {
      contracts: stub(gates.contracts ?? (async () => undefined)),
      secretScan: stub(gates.secretScan ?? (async () => undefined)),
    })
    for (const gate of PRODUCT_GATES) {
      module[gate] = stub(gates[gate] ?? (async () => undefined)) as never
    }
    return module
  }

  test("runs product gates two at a time, browser shards first, and finishes them all", async () => {
    const started: string[] = []
    let inFlight = 0
    let peak = 0
    const gate = (name: string) => async () => {
      started.push(name)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((done) => setTimeout(done, 5))
      inFlight -= 1
    }
    const module = await ciModule(Object.fromEntries(PRODUCT_GATES.map((name) => [name, gate(name)])))
    await expect(module.ci("1".repeat(40))).resolves.toContain("gates passed")
    expect(started.slice(0, 2)).toEqual(["browserChromium", "browserJourneys"])
    expect(started.sort()).toEqual([...PRODUCT_GATES].sort())
    expect(peak).toBe(2)
  })

  test("gate runs exactly the one named gate, the same container ci runs", async () => {
    const started: string[] = []
    const record = (name: string) => async () => void started.push(name)
    const module = await ciModule({
      ...Object.fromEntries(PRODUCT_GATES.map((name) => [name, record(name)])),
      contracts: record("contracts"),
      secretScan: record("secretScan"),
    })
    await expect(module.gate("browserWizards", "1".repeat(40))).resolves.toBe("browserWizards gate passed.")
    await expect(module.gate("secretScan", "1".repeat(40))).resolves.toBe("secretScan gate passed.")
    await expect(module.gate("contracts", "1".repeat(40))).resolves.toBe("contracts gate passed.")
    expect(started).toEqual(["browserWizards", "secretScan", "contracts"])
  })

  test("a red gate fails its gate call by name", async () => {
    const module = await ciModule({
      privacy: async () => {
        throw new Error("verify-privacy-reset exited 1")
      },
    })
    await expect(module.gate("privacy", "1".repeat(40))).rejects.toThrow("privacy: verify-privacy-reset exited 1")
  })

  test("an unknown gate name is refused before anything runs", async () => {
    const started: string[] = []
    const module = await ciModule({ backend: async () => void started.push("backend") })
    await expect(module.gate("browser", "1".repeat(40))).rejects.toThrow('unknown gate "browser"')
    expect(started).toEqual([])
  })

  test("the aggregate verdict is exposed as a function", async () => {
    const module = await ciModule({})
    expect(() => module.verdict("failure")).toThrow("gate job results")
  })

  test("one red gate fails ci by name after the others finish", async () => {
    const finished: string[] = []
    const module = await ciModule({
      backend: async () => void finished.push("backend"),
      browserJourneys: async () => {
        throw new Error("verify-exit-gate exited 1")
      },
      privacy: async () => void finished.push("privacy"),
    })
    await expect(module.ci("1".repeat(40))).rejects.toThrow("browserJourneys: verify-exit-gate exited 1")
    expect(finished.sort()).toEqual(["backend", "privacy"])
  })

  test("a failing contracts gate fails ci too", async () => {
    const module = await ciModule({
      contracts: async () => {
        throw new Error("bun test red")
      },
    })
    await expect(module.ci("1".repeat(40))).rejects.toThrow("contracts: bun test red")
  })

  test("a failing source guard stops before any product gate starts", async () => {
    const started: string[] = []
    const record = (name: string) => async () => void started.push(name)
    const module = await ciModule({
      secretScan: async () => {
        throw new Error("secret found")
      },
      backend: record("backend"),
      browserChromium: record("browserChromium"),
    })
    await expect(module.ci("1".repeat(40))).rejects.toThrow("secret found")
    expect(started).toEqual([])
  })
})

describe("memory-budget lane", () => {
  test("the browser gate runs it on the hooks-off production build", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const browser = source.slice(source.indexOf("  browserWebkitReal(): Container {"), source.indexOf("  browserMatrix(): Container {"))
    const lane = "MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget"
    expect(browser).toContain(lane)
    // After the hooks-off dist-real build, inside its preview — not the dist-verify (hooks on) one.
    expect(browser.indexOf(lane)).toBeGreaterThan(browser.indexOf('this.localPreview(real, "dist-real"'))
    const scripts = JSON.parse(readFileSync(resolve(root, "frontend/apps/web/package.json"), "utf8")).scripts
    expect(scripts["test:e2e:memory-budget"]).toBe("playwright test --config=playwright.memory-budget.config.ts")
  })
})

describe("browser Lego caret pin", () => {
  // edgeprocPinCheck greps every consumer manifest for BROWSER_LEGO_SPEC inside
  // the shared bun base. A dependency bump that leaves the constant behind
  // fails every bun gate in CI (run 37352985472) while every local gate stays
  // green, so the constant and the manifests are tied here.
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
  const spec = source.match(/const BROWSER_LEGO_SPEC = '([^']+)'/)?.[1]

  test("declares the spec the pin check greps for", () => {
    expect(spec).toMatch(/^"@gainratio\/browser": "\^\d+\.\d+\.\d+"$/)
  })

  for (const manifest of ["browser", "memory", "store"]) {
    test(`packages/${manifest}/package.json carries exactly that spec`, () => {
      const text = readFileSync(resolve(root, `frontend/packages/${manifest}/package.json`), "utf8")
      expect(text).toContain(spec ?? "(BROWSER_LEGO_SPEC missing)")
    })
  }
})
