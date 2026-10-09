import { PRODUCT_GATES } from "../dagger/src/gates.ts"
import { describe, expect, mock, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const centralSha = "8fbde750dafd431c1777f2bf63b3170ef6db2caf"
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
        source: `github.com/gainratio/ci/modules/cloudflare-pages@${centralSha}`,
        pin: centralSha,
      },
      {
        name: "foundation",
        source: `github.com/gainratio/ci/modules/portfolio-foundation@${centralSha}`,
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
      '"ghcr.io/hseshadr/mirror/docker.io/library/node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff"',
    )
    expect(pagesBase).toContain('.container({ platform: "linux/amd64" as Platform })')
    expect(pagesBase).toContain('`wrangler@${WRANGLER_VERSION}`')
    expect(source).not.toContain("WRANGLER_NODE")
    expect(bunBase).toContain("node-gyp nodejs poppler-utils")
    expect(bunBase).not.toContain("NODE_IMAGE")
  })

  // Debian's apt `node-gyp` drags in Debian's nodejs and links every addon it
  // builds against that libnode. Loaded into NODE_IMAGE's own Node, the addon
  // brings a second V8 into the process: on linux/arm64, where ws's optional
  // bufferutil/utf-8-validate have no prebuild and get compiled, `vite build`
  // died with "this.#build is not a function" and SIGSEGV (exit 139).
  test("builds release native addons against the release image's own Node", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const releaseBase = source.slice(
      source.indexOf("private releaseBase("),
      source.indexOf("private browserBase("),
    )
    const aptInstall = releaseBase.match(/apt-get install[^"]*/)?.[0] ?? ""

    expect(releaseBase).toContain(".from(NODE_IMAGE)")
    expect(aptInstall).toContain("build-essential")
    expect(aptInstall).not.toMatch(/\bnode-gyp\b/)
    expect(aptInstall).not.toMatch(/\bnodejs\b/)
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

    await expect(module.ci(commitSha, repository)).rejects.toBe(guardFailure)
    // Contracts now start alongside the guard (they used to run strictly before
    // it), so order is not part of the contract: both run, product gates never do.
    expect([...orchestration].sort()).toEqual(["contracts", "foundation"])
    expect(guardCalls).toEqual([{ source, repository, commitSha }])
    expect(productGates).toEqual([])
  })
})

describe("the source guard runs as the run's own repository", () => {
  async function guardedModule(guardCalls: string[]) {
    const noOpDecorator = () => () => undefined
    // A chainable stand-in for Container: every method returns itself, `sync`
    // resolves, and it is not a thenable (so `await` does not hang on it).
    const inert: unknown = new Proxy({}, {
      get: (_target, key) => {
        if (key === "then") return undefined
        return key === "sync" ? async () => inert : () => inert
      },
    })
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
        container: () => inert,
        foundation: () => ({
          guard: (_source: unknown, guardRepository: string) => {
            guardCalls.push(guardRepository)
            return inert
          },
        }),
      },
    }))
    const { AlmameshCi } = await import("../dagger/src/index.ts")
    return new AlmameshCi({ directory: () => ({}) } as never)
  }

  test.each([
    ["hseshadr", "hseshadr/almamesh", "hseshadr/almamesh"],
    ["gainratio", "gainratio/almamesh", "gainratio/almamesh"],
  ])("secretScan guards %s", async (_name, runRepository, expected) => {
    const guardCalls: string[] = []
    const module = await guardedModule(guardCalls)
    module.secretScan("1".repeat(40), runRepository)
    expect(guardCalls).toEqual([expected])
  })

  // Dagger makes a parameter optional only when it has a default. Each entry point
  // that acts as the repository must REQUIRE the run's `github.repository`, so its
  // declared arity counts the repository parameter (a default would drop it).
  test.each([
    ["ci", 2],
    ["gate", 3],
    ["secretScan", 2],
    ["productionArtifact", 6],
    ["deploy", 9],
    ["publishToolchain", 3],
  ])("%s requires the run repository (arity %i, no default)", async (name, arity) => {
    const module = await guardedModule([])
    const method = (module as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
    expect(method.length).toBe(arity)
  })

  test("the gate refuses a missing run repository before the guard runs", async () => {
    const guardCalls: string[] = []
    const module = await guardedModule(guardCalls)
    const gate = module.gate.bind(module) as (...args: unknown[]) => Promise<string>
    await expect(gate("secretScan", "1".repeat(40))).rejects.toThrow("is not an allowed repository")
    expect(guardCalls).toEqual([])
  })

  test("the secretScan gate forwards the run repository to the guard", async () => {
    const guardCalls: string[] = []
    const module = await guardedModule(guardCalls)
    await module.gate("secretScan", "1".repeat(40), "gainratio/almamesh")
    expect(guardCalls).toEqual(["gainratio/almamesh"])
  })

  test.each([
    "attacker/almamesh",
    "gainratio/aml-filter",
    "hseshadr/almamesh-evil",
    "gainratio-evil/almamesh",
    "",
    undefined,
  ])("secretScan refuses run repository %p before the guard runs", async (runRepository) => {
    const guardCalls: string[] = []
    const module = await guardedModule(guardCalls)
    expect(() => module.secretScan("1".repeat(40), runRepository as string)).toThrow("is not an allowed repository")
    expect(guardCalls).toEqual([])
  })
})

describe("the Pages upload keeps the Git source bound to today's owner", () => {
  test("every cloudflare-pages deploy passes gitSourceOwner hseshadr", async () => {
    const noOpDecorator = () => () => undefined
    const calls: unknown[][] = []
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
        cloudflarePages: () => ({
          deploy: (...args: unknown[]) => {
            calls.push(args)
            return "lazy-evidence"
          },
        }),
      },
    }))
    const { AlmameshCi } = await import("../dagger/src/index.ts")
    const module = new AlmameshCi({ directory: () => ({}) } as never) as unknown as {
      providerDeploy: (...args: unknown[]) => unknown
    }
    const request = {
      workflowRunId: "781",
      runAttempt: 3,
      repository,
      project: "almamesh",
      productionBranch: "main",
      liveDomain: "almamesh.com",
      deployRoot: "dist",
      domains: ["www.almamesh.com"],
      consumerIdentity: `${repository}@${"1".repeat(40)}`,
      producingIdentity: `${centralSha}:781`,
      allowedRoots: ["dist", "functions"],
      pagesFunctions: true,
    }
    expect(module.providerDeploy("envelope", "gh", "cf-token", "cf-account", request)).toBe("lazy-evidence")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.at(-1)).toEqual({ pagesFunctions: true, gitSourceOwner: "hseshadr" })
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
    await expect(module.ci("1".repeat(40), repository)).resolves.toContain("gates passed")
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
    await expect(module.gate("browserWizards", "1".repeat(40), repository)).resolves.toBe("browserWizards gate passed.")
    await expect(module.gate("secretScan", "1".repeat(40), repository)).resolves.toBe("secretScan gate passed.")
    await expect(module.gate("contracts", "1".repeat(40), repository)).resolves.toBe("contracts gate passed.")
    expect(started).toEqual(["browserWizards", "secretScan", "contracts"])
  })

  test("a red gate fails its gate call by name", async () => {
    const module = await ciModule({
      privacy: async () => {
        throw new Error("verify-privacy-reset exited 1")
      },
    })
    await expect(module.gate("privacy", "1".repeat(40), repository)).rejects.toThrow("privacy: verify-privacy-reset exited 1")
  })

  test("an unknown gate name is refused before anything runs", async () => {
    const started: string[] = []
    const module = await ciModule({ backend: async () => void started.push("backend") })
    await expect(module.gate("browser", "1".repeat(40), repository)).rejects.toThrow('unknown gate "browser"')
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
    await expect(module.ci("1".repeat(40), repository)).rejects.toThrow("browserJourneys: verify-exit-gate exited 1")
    expect(finished.sort()).toEqual(["backend", "privacy"])
  })

  test("a failing contracts gate fails ci too", async () => {
    const module = await ciModule({
      contracts: async () => {
        throw new Error("bun test red")
      },
    })
    await expect(module.ci("1".repeat(40), repository)).rejects.toThrow("contracts: bun test red")
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
    await expect(module.ci("1".repeat(40), repository)).rejects.toThrow("secret found")
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

  // The lock must never carry a Git alias of our own libraries under EITHER owner:
  // after the transfer an alias would read github:gainratio/..., not hseshadr.
  async function pinCheckExit(lock: string): Promise<number> {
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
      dag: { cacheVolume: () => ({}) },
    }))
    const { AlmameshCi } = await import("../dagger/src/index.ts")
    const module = new AlmameshCi({ directory: () => ({}) } as never) as unknown as {
      edgeprocPinCheck: () => string[]
    }
    const dir = mkdtempSync(join(tmpdir(), "pin-check-"))
    for (const manifest of ["browser", "memory", "store"]) {
      mkdirSync(join(dir, "packages", manifest), { recursive: true })
      writeFileSync(join(dir, "packages", manifest, "package.json"), `{ ${spec} }`)
    }
    writeFileSync(join(dir, "bun.lock"), lock)
    return Bun.spawnSync(module.edgeprocPinCheck(), { cwd: dir }).exitCode
  }

  test("passes a lock that resolves our libraries from npm", async () => {
    expect(await pinCheckExit('"@gainratio/browser": ["@gainratio/browser@0.4.1", ""]')).toBe(0)
  })

  test.each(["hseshadr", "gainratio"])("refuses a %s Git alias in the lock", async (owner) => {
    expect(await pinCheckExit(`"@gainratio/browser": ["github:${owner}/edgeproc-browser#edd9971"]`)).not.toBe(0)
  })

  for (const manifest of ["browser", "memory", "store"]) {
    test(`packages/${manifest}/package.json carries exactly that spec`, () => {
      const text = readFileSync(resolve(root, `frontend/packages/${manifest}/package.json`), "utf8")
      expect(text).toContain(spec ?? "(BROWSER_LEGO_SPEC missing)")
    })
  }
})

// Moved from tests/dagger-contracts.test.ts, which needs a host `dagger` and is
// local-only; these need no dagger CLI, so the `contracts` gate runs them.
describe("Dagger orchestration source contracts", () => {
  test("production deploy composes one central Pages Functions transaction", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    expect(source).toContain("deliverProduction")
    expect(source).toContain(".greenMainDecision(")
    expect(source).toContain(".source(")
    expect(source).toContain(".guard(")
    expect(source).toContain(".envelope(")
    expect(source).toContain(
      "{ pagesFunctions: request.pagesFunctions, gitSourceOwner: PAGES_GIT_SOURCE_OWNER }",
    )
    expect(source).toContain("loadCloudflarePagesDeploymentEvidenceFromID")
    expect(source).not.toContain(".preflight(")
    expect(source).not.toContain(".verifyEnvelope(")
    expect(source).not.toContain("dag.cloudflarePages().verify(")
    expect(source).not.toContain("verify-pages-source.mjs")
    expect(source).not.toContain("pagesDeployScript")
  })

  test("package installs cannot reuse partially downloaded Bun tarballs", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    expect(source).not.toContain('withMountedCache("/root/.bun/install/cache"')
  })

  test("Bun installs time out, clean ephemeral state, retry once, and fail closed", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "almamesh-bun-install-"))
    const installer = resolve(root, "dagger/scripts/install-bun.sh")
    const counter = join(sandbox, "attempts")
    const args = join(sandbox, "args")
    writeFileSync(join(sandbox, "timeout"), [
      "#!/bin/sh", "shift 3", '"$@" &', "pid=$!", '( sleep 1; kill "$pid" 2>/dev/null ) &',
      "watch=$!", 'wait "$pid"', "status=$?", 'kill "$watch" 2>/dev/null || true', "exit $status",
    ].join("\n"))
    writeFileSync(join(sandbox, "bun"), [
      "#!/bin/sh", "set -eu", `counter='${counter}'`, `args='${args}'`,
      'attempt=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))', 'echo "$attempt" > "$counter"',
      'echo "$*" >> "$args"',
      'if [ "${FAKE_FAIL:-}" = always ]; then mkdir -p node_modules "$BUN_INSTALL_CACHE_DIR"; touch node_modules/final-partial "$BUN_INSTALL_CACHE_DIR/final-partial"; exit 9; fi',
      'if [ "$attempt" -eq 1 ]; then sleep 5; fi', "mkdir -p node_modules",
    ].join("\n"))
    chmodSync(join(sandbox, "timeout"), 0o755)
    chmodSync(join(sandbox, "bun"), 0o755)
    const env = {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH ?? ""}`,
      BUN_INSTALL_CACHE_DIR: join(sandbox, "cache"),
      BUN_INSTALL_TIMEOUT_SECONDS: "1",
    }
    try {
      const recovered = spawnSync("bash", [installer], { cwd: sandbox, env, encoding: "utf8" })
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(counter, "utf8").trim()).toBe("2")
      expect(readFileSync(args, "utf8").trim().split("\n"))
        .toEqual(["install --frozen-lockfile", "install --frozen-lockfile"])
      const failed = spawnSync("bash", [installer], {
        cwd: sandbox, env: { ...env, FAKE_FAIL: "always" }, encoding: "utf8",
      })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain("failed after 2 attempts")
      expect(existsSync(join(sandbox, "node_modules/final-partial"))).toBe(true)
      expect(existsSync(join(sandbox, "cache/final-partial"))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 10_000)
})
