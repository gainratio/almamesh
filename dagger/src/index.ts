import {
  CacheVolume,
  Container,
  Directory,
  ReturnType,
  Secret,
  Service,
  Workspace,
  dag,
  func,
  object,
} from "@dagger.io/dagger"
import type { CloudflarePagesDeploymentEvidenceID, Platform } from "@dagger.io/dagger"
import { randomUUID } from "node:crypto"
import {
  PAGES_TARGET,
  deliverProduction,
  indexNowScript as releaseIndexNowScript,
  liveVerificationScript as releaseLiveVerificationScript,
  validateProviderEvidence,
  type GreenMainEvidence,
  type ProviderRequest,
  type SmokePass,
  type SmokeRun,
} from "./deployment.js"

const ROOT = "/workspace"
const FRONTEND = `${ROOT}/frontend`
const WEB = `${FRONTEND}/apps/web`
const DIST = `${WEB}/dist`
const KEYS = "/run/almamesh-keys"
const BUN_INSTALLER = "/opt/almamesh/install-bun.sh"
const LIVE_ORIGIN = "https://almamesh.com"
const REPOSITORY = "hseshadr/almamesh"
const EDGEPROC_BROWSER_SHA = "02171df60afc8b09d6439112ea7ea3202338d46a"
const CONTRACT_SHA = "1111111111111111111111111111111111111111"
const CENTRAL_MODULE_SHA = "9d491851fc5c65ad4a388ed2dd7bb4def4e1f007"
const BUN_IMAGE =
  "oven/bun:1.3.5@sha256:e90cdbaf9ccdb3d4bd693aa335c3310a6004286a880f62f79b18f9b1312a8ec3"
const NODE_IMAGE =
  "node:22-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284"
const PAGES_NODE_IMAGE =
  "node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff"
const UV_IMAGE =
  "ghcr.io/astral-sh/uv:0.12.1-python3.13-trixie-slim@sha256:8db423175bfff42bd1c81f77280bc92f10ef9cf03161803bd5cb6e15d86c3d10"
const WRANGLER_VERSION = "4.103.0"
const WRANGLER = "/opt/wrangler/node_modules/.bin/wrangler"
const WRANGLER_COMPATIBILITY_DATE = "2026-06-24"
const SOURCE_EXCLUDES = [
  ".git/**",
  "**/.env",
  "**/.env.local",
  "**/.env.*.local",
  "**/*private*.key",
  "**/node_modules/**",
  "**/dist*/**",
  "**/.venv/**",
  "dagger/sdk/**",
]
const CONTRACT_TESTS = [
  "tests/dagger-deployment-contract.test.ts",
  "tests/dagger-foundation-contract.test.ts",
  "tests/dagger-workflow-contract.test.ts",
]
const SMOKE_OUTPUT_LINES = 60

interface ReleaseArtifact {
  dist: Directory
  roots: Directory
}

type PagesClient = ReturnType<typeof dag.cloudflarePages>
type PagesEvidence = ReturnType<PagesClient["deploy"]>

@object()
export class AlmameshCi {
  source: Directory

  constructor(workspace: Workspace) {
    this.source = workspace.directory("/", {
      exclude: SOURCE_EXCLUDES,
      gitignore: false,
    })
  }

  private selected(include: string[]): Directory {
    return this.source.filter({ include, gitignore: false })
  }
  private cache(name: string): CacheVolume {
    return dag.cacheVolume(`almamesh-${name}`)
  }
  private bunBase(): Container {
    return dag
      .container()
      .from(BUN_IMAGE)
      .withFile(BUN_INSTALLER, this.source.file("dagger/scripts/install-bun.sh"))
      .withDirectory(ROOT, this.selected([".gitignore", ".github/workflows/**", "CHANGELOG.md", "README.md", "SECURITY.md", "backend/**", "dagger/**", "docs/**", "frontend/**", "testdata/**"]))
      .withWorkdir(FRONTEND)
      .withEnvVariable("ALMAMESH_CI_CONTRACT", "modern-v13")
      .withEnvVariable("HUSKY", "0")
      .withNewFile("/tmp/node-contract.cjs", "Promise.withResolvers ||= () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }")
      .withEnvVariable("NODE_OPTIONS", "--require=/tmp/node-contract.cjs")
      .withEnvVariable("PYTHON", "/usr/bin/python3")
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install -y --no-install-recommends build-essential git node-gyp nodejs poppler-utils && rm -rf /var/lib/apt/lists/*",
      ])
      .withExec(this.edgeprocPinCheck())
      .withExec(["sh", BUN_INSTALLER])
      .withExec(["sh", "-c", `git -C ${ROOT} init && git -C ${ROOT} add -A`])
  }

  private pagesFunctionsBuildArgs(): string[] {
    return [
      "wrangler",
      "pages",
      "functions",
      "build",
      "functions",
      "--outfile=/derived/_worker.js",
      "--output-routes-path=/derived/_routes.json",
      "--project-directory=/project",
      "--build-output-directory=/project/dist",
      "--metafile=/derived/_build-metadata.json",
    ]
  }

  private pagesFunctionsBase(): Container {
    return dag
      .container({ platform: "linux/amd64" as Platform })
      .from(PAGES_NODE_IMAGE)
      .withEnvVariable("WRANGLER_SEND_METRICS", "false")
      .withExec([
        "npm",
        "install",
        "--global",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `wrangler@${WRANGLER_VERSION}`,
      ])
  }

  private pagesFunctionsBuild(roots: Directory): Container {
    const closedRoots = roots.withNewDirectory(".wrangler")
    return this.pagesFunctionsBase()
      .withMountedDirectory("/project", closedRoots, { readOnly: true })
      .withMountedTemp("/project/.wrangler")
      .withDirectory("/derived", dag.directory())
      .withMountedTemp("/run/functions-cache")
      .withMountedTemp("/run/functions-config")
      .withEnvVariable("WRANGLER_CACHE_DIR", "/run/functions-cache")
      .withEnvVariable("XDG_CONFIG_HOME", "/run/functions-config")
      .withWorkdir("/project")
      .withExec(this.pagesFunctionsBuildArgs())
  }

  private uvBase(): Container {
    return dag
      .container()
      .from(UV_IMAGE)
      .withDirectory(
        ROOT,
        this.selected([
          ".github/workflows/deploy.yml",
          "backend/**",
          "frontend/packages/browser/src/pyodide/*.ts",
          "testdata/**",
          // backend/tests/test_readme_contract.py: the README, the package
          // description it must equal, and every file the README links to.
          "README.md",
          "CHANGELOG.md",
          "CONTRIBUTING.md",
          "LICENSE",
          "SECURITY.md",
          "docs/**",
          "examples/**",
          "frontend/README.md",
          "frontend/package.json",
        ]),
      )
      .withWorkdir(`${ROOT}/backend`)
      .withEnvVariable("UV_LINK_MODE", "copy")
      .withEnvVariable("UV_PROJECT_ENVIRONMENT", "/opt/venv")
      .withMountedCache("/root/.cache/uv", this.cache("uv"))
      .withExec(["uv", "sync", "--locked", "--extra", "dev"])
  }

  private releaseBase(source: Directory): Container {
    const bun = dag.container().from(BUN_IMAGE).file("/usr/local/bin/bun")
    const uv = dag.container().from(UV_IMAGE).file("/usr/local/bin/uv")
    return dag
      .container()
      .from(NODE_IMAGE)
      .withFile("/usr/local/bin/bun", bun)
      .withFile("/usr/local/bin/uv", uv)
      .withFile("/usr/local/bin/uvx", uv)
      .withFile(BUN_INSTALLER, source.file("dagger/scripts/install-bun.sh"))
      .withDirectory(
        ROOT,
        source.filter({ include: [".gitignore", "backend/**", "frontend/**"], gitignore: false }),
      )
      .withWorkdir(FRONTEND)
      .withEnvVariable("UV_LINK_MODE", "copy")
      .withEnvVariable("UV_PROJECT_ENVIRONMENT", "/opt/venv")
      .withEnvVariable("HUSKY", "0")
      .withEnvVariable("PYTHON", "/usr/bin/python3")
      .withEnvVariable("WRANGLER", WRANGLER)
      .withMountedCache("/root/.cache/uv", this.cache("uv"))
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl git node-gyp openssl poppler-utils python3 python3-dev && rm -rf /var/lib/apt/lists/*",
      ])
      .withExec(this.edgeprocPinCheck())
      .withExec(["sh", BUN_INSTALLER])
      .withExec([
        "npm",
        "install",
        "--prefix",
        "/opt/wrangler",
        "--no-audit",
        "--no-fund",
        "--no-save",
        `wrangler@${WRANGLER_VERSION}`,
      ])
      .withExec(["bash", "apps/web/scripts/setup-dev-assets.sh"])
      .withWorkdir(WEB)
  }

  private browserBase(browsers: string[]): Container {
    return this.browserToolchain()
      .withExec(["bash", "apps/web/scripts/setup-dev-assets.sh"])
      .withWorkdir(WEB)
      .withExec(["bun", "x", "playwright", "install", "--with-deps", ...browsers])
  }

  private browserToolchain(): Container {
    const bun = dag.container().from(BUN_IMAGE).file("/usr/local/bin/bun")
    return dag
      .container()
      .from(UV_IMAGE)
      .withFile("/usr/local/bin/bun", bun)
      .withFile(BUN_INSTALLER, this.source.file("dagger/scripts/install-bun.sh"))
      .withDirectory(ROOT, this.selected(["backend/**", "frontend/**"]))
      .withWorkdir(FRONTEND)
      .withEnvVariable("UV_LINK_MODE", "copy")
      .withEnvVariable("UV_PROJECT_ENVIRONMENT", "/opt/venv")
      .withEnvVariable("VITE_API_URL", "")
      .withEnvVariable("HUSKY", "0")
      .withEnvVariable("PYTHON", "/usr/bin/python3")
      .withMountedCache("/root/.cache/uv", this.cache("uv"))
      .withMountedCache("/root/.skyfield-data", this.cache("skyfield"))
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl git node-gyp nodejs openssl poppler-utils && rm -rf /var/lib/apt/lists/*",
      ])
      .withExec(this.edgeprocPinCheck())
      .withExec(["sh", BUN_INSTALLER])
  }

  private edgeprocPinCheck(): string[] {
    const pin = `github:hseshadr/edgeproc-browser#${EDGEPROC_BROWSER_SHA}`
    return [
      "sh",
      "-c",
      `grep -F ${JSON.stringify(pin)} packages/browser/package.json >/dev/null && grep -F ${JSON.stringify(pin)} packages/memory/package.json >/dev/null && grep -F ${JSON.stringify(pin)} packages/store/package.json >/dev/null && grep -F ${JSON.stringify(EDGEPROC_BROWSER_SHA)} bun.lock >/dev/null`,
    ]
  }

  private builtBrowser(
    output: string,
    hooks = false,
    browsers = ["chromium", "webkit"],
  ): Container {
    let container = this.browserBase(browsers)
    if (hooks) container = container.withEnvVariable("VITE_EXIT_GATE_HOOKS", "1")
    return container.withExec([
      "./node_modules/.bin/vite",
      "build",
      "--outDir",
      output,
    ])
  }

  @func()
  async contracts(): Promise<Container> {
    await this.deployDryRun(CONTRACT_SHA).sync()
    return dag
      .container()
      .from(BUN_IMAGE)
      .withDirectory(
        ROOT,
        this.selected([
          ".github/workflows/dagger.yml",
          ".github/workflows/deploy.yml",
          "dagger.json",
          "dagger/scripts/**",
          "dagger/src/**",
          ...CONTRACT_TESTS,
        ]),
      )
      .withWorkdir(ROOT)
      .withExec(["bun", "test", ...CONTRACT_TESTS])
      .withExec(["printf", "%s\n", `Passed: ${CONTRACT_TESTS.join(" ")}`])
  }

  @func()
  backend(): Container {
    return this.uvBase().withExec(["uv", "run", "poe", "gate"])
  }
  @func()
  frontend(): Container {
    return this.bunBase().withExec(["bun", "run", "gate"])
  }
  @func()
  browser(): Container {
    let checked = this.builtBrowser("dist-verify", true)
      .withExec(["node", "scripts/verify-precache-redirect.mjs", "dist-verify"])
    checked = this.localPreview(checked, "dist-verify", [
      "node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4199 --browser=chromium",
      "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4199 --browser=chromium",
      "PORTABLE_SQLITE_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-sqlite",
      "node scripts/verify-exit-gate.mjs http://127.0.0.1:4199",
      "node scripts/verify-i18n.mjs http://127.0.0.1:4199",
      "node scripts/verify-browser-parity.mjs http://127.0.0.1:4199 --reference-date=2025-01-01T00:00:00+00:00",
    ])
    checked = this.localServer(
      checked,
      "./node_modules/.bin/vite preview --outDir dist-verify --host 127.0.0.1 --port 4200 --strictPort",
      4200,
      [
        "node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4200 --browser=webkit",
        "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4200 --browser=webkit",
        "node scripts/verify-webkit-engine.mjs http://127.0.0.1:4200",
        "node scripts/verify-webkit-engine.mjs http://127.0.0.1:4200 --first-session --transient-cache-visibility",
      ],
    )
    checked = checked
      .withExec(["bun", "run", "test:e2e:interp"])
      .withExec(["bun", "run", "test:e2e:chat:grounding"])
      .withExec(["bun", "run", "test:e2e:rectification"])
      .withExec(["bun", "run", "test:e2e:wizard"])

    const real = checked.withEnvVariable("VITE_EXIT_GATE_HOOKS", "").withExec([
      "./node_modules/.bin/vite",
      "build",
      "--outDir",
      "dist-real",
    ])
      // Returning visitor across a deploy: precache entries cached before a
      // header change must not stop the engine from booting (the stuck
      // "still starting up" regression). Owns its own origin on :4197.
      .withExec(["bun", "run", "test:e2e:returning-visitor"])
    return this.localPreview(real, "dist-real", [
      "node scripts/verify-real-onboarding.mjs http://127.0.0.1:4199",
      "node scripts/verify-onboarding-recovery.mjs http://127.0.0.1:4199",
    ])
  }
  @func()
  pdf(): Container {
    return this.browserBase(["chromium"])
      .withExec(["bun", "run", "test:e2e:ai"])
      .withExec(["bun", "run", "test:e2e:report:pdf"])
  }
  @func()
  privacy(): Container {
    const built = this.builtBrowser("dist-privacy", false, ["chromium"])
    return this.localPreview(
      built.withEnvVariable("ALMAMESH_PRIVACY_CONTRACT", "backup-reset-v4"),
      "dist-privacy",
      ["node scripts/verify-privacy-reset.mjs http://127.0.0.1:4199"],
    )
  }
  @func()
  async ci(commitSha: string): Promise<string> {
    await (await this.contracts()).sync()
    const gates = [
      this.secretScan(commitSha),
      this.backend(),
      this.frontend(),
      this.browser(),
      this.pdf(),
      this.privacy(),
    ]
    for (const gate of gates) await gate.sync()
    return "Contract, secret, backend, frontend, browser, PDF, and privacy gates passed in sequence."
  }
  @func()
  secretScan(commitSha: string): Container {
    return dag
      .foundation()
      .guard(this.source, REPOSITORY, commitSha)
      .withDirectory(ROOT, this.source)
      .withWorkdir(ROOT)
      .withExec([
        "sh",
        "-ceu",
        'test -z "$(find backend -maxdepth 1 \\( -name \'keys*\' -o -name \'origin*\' \\) -print -quit)"',
      ])
  }
  @func()
  async dependencyAudit(): Promise<string> {
    const python = this.uvBase()
      .withExec([
        "uv",
        "export",
        "--frozen",
        "--all-extras",
        "--no-emit-project",
        "--no-hashes",
        "-o",
        "/tmp/requirements.txt",
      ])
      .withExec(["uvx", "pip-audit", "-r", "/tmp/requirements.txt", "--disable-pip", "--no-deps"])
    const frontend = this.bunBase().withExec(["bun", "audit"])
    await Promise.all([python.sync(), frontend.sync()])
    return "Python and Bun locked dependency graphs passed their advisory audits."
  }
  @func()
  async productionArtifact(
    bundlePrivateKeyB64: Secret,
    bundlePublicKeyB64: Secret,
    expectedSha: string,
    bundleVersion: string,
    bundleSequence: number,
  ): Promise<Directory> {
    const source = await this.verifiedPublicSource(expectedSha)
    return this.releaseArtifact(source, this.signedBuild(
      source,
      bundlePrivateKeyB64,
      bundlePublicKeyB64,
      expectedSha,
      bundleVersion,
      bundleSequence,
    )).roots
  }
  @func()
  deployDryRun(expectedSha: string): Container {
    const release = this.withoutSigningSecrets(
      this.releaseBase(this.source)
        .withMountedTemp(KEYS)
        .withEnvVariable("EXPECTED_SHA", expectedSha)
        .withExec(["bash", "-c", this.dryRunBuildScript()]),
    )
    const functions = dag.directory().withFile(
      "api/feedback.ts",
      this.source.file("frontend/apps/web/functions/api/feedback.ts"),
    )
    const roots = dag
      .directory()
      .withDirectory("dist", release.directory(DIST))
      .withDirectory("functions", functions)
    return this.pagesFunctionsProof(roots, expectedSha)
  }
  @func()
  async deploy(
    githubToken: Secret,
    cloudflareApiToken: Secret,
    cloudflareAccountId: Secret,
    bundlePrivateKeyB64: Secret,
    bundlePublicKeyB64: Secret,
    expectedSha: string,
    workflowRunId: string,
    runAttempt: number,
  ): Promise<string> {
    const result = await deliverProduction({
      greenMain: async () => dag.foundation().greenMain(githubToken, REPOSITORY).serialization(),
      bindSource: async (evidence) => this.materializedPublicSource(evidence.commitSha),
      guardSource: async (source, evidence) => {
        await dag.foundation().guard(source, REPOSITORY, evidence.commitSha).sync()
      },
      buildRelease: async (source, evidence) => this.releaseArtifact(
        source,
        this.signedBuild(
          source,
          bundlePrivateKeyB64,
          bundlePublicKeyB64,
          evidence.commitSha,
        ),
      ),
      verifyPreview: async (artifact, evidence) => {
        await this.pagesFunctionsProof(artifact.roots, evidence.commitSha).sync()
      },
      createEnvelope: async (artifact, identities, roots) => {
        const envelope = dag.foundation().envelope(
          artifact.roots,
          identities.consumer,
          identities.producer,
          [...roots],
        )
        await envelope.digest()
        return envelope
      },
      deployPages: (envelope, request) => this.providerDeploy(
        envelope,
        githubToken,
        cloudflareApiToken,
        cloudflareAccountId,
        request,
      ),
      evidenceId: async (evidence) => evidence.id(),
      reloadEvidence: (id) => dag.loadCloudflarePagesDeploymentEvidenceFromID(
        id as CloudflarePagesDeploymentEvidenceID,
      ),
      providerIdentity: async (provider, source) => this.providerIdentity(provider, source),
      verifyLive: async (artifact, evidence) => this.verifyReleased(artifact, evidence),
      smokeLive: async (passes, previousUrl) => this.liveSmoke(passes, previousUrl),
    }, expectedSha, workflowRunId, runAttempt, CENTRAL_MODULE_SHA)
    return [
      `Cloudflare Pages deployment verified: ${result.deploymentId} ${result.deploymentUrl}`,
      result.liveProof,
    ].join("\n")
  }
  @func()
  verifyLive(expectedSha: string, artifact: Directory): Container {
    return dag
      .container()
      .from(BUN_IMAGE)
      .withDirectory("/artifact", artifact)
      .withEnvVariable("EXPECTED_SHA", expectedSha)
      .withExec(["bash", "-c", this.liveVerificationScript("/artifact")])
  }
  /**
   * Scheduled fresh-visitor smoke against production (no credentials). Never
   * cached: a remembered green would report a site that may have broken since.
   */
  @func({ cache: "never" })
  async liveProbe(): Promise<string> {
    const run = await this.liveSmokePass("fresh")
    if (!run.passed) throw new Error(`Live probe failed (fresh) against ${LIVE_ORIGIN}\n${run.output}`)
    return `Live probe passed (fresh) against ${LIVE_ORIGIN}\n${run.output}`
  }
  @func()
  web(): Directory {
    return this.bunBase()
      .withWorkdir(WEB)
      .withExec(["bun", "run", "build"])
      .directory(`${WEB}/dist`)
  }
  @func()
  serve(): Service {
    const built = this.builtBrowser("dist")
    return this.preview(built, "dist", 4173)
  }
  @func()
  nightly(openrouterApiKey?: Secret): Container {
    const runner = this.browserBase(["chromium"])
      .withoutMount("/root/.cache/uv").withoutMount("/root/.bun/install/cache").withoutMount("/root/.skyfield-data")
    return (openrouterApiKey ? runner.withSecretVariable("OPENROUTER_API_KEY", openrouterApiKey) : runner)
      .withExec(["node", "scripts/build-sw-update-fixtures.mjs"])
      .withExec(["bun", "run", "test:e2e:sw-update"])
      .withExec(["bun", "run", "test:e2e:ai"])
      .withExec(["bun", "run", "test:e2e:interp"])
      .withExec(["bun", "run", "test:e2e:chat:grounding"])
      .withExec(["bun", "run", "test:e2e:rectification"])
      .withExec(["bun", "run", "test:e2e:wizard"])
      .withExec(["bun", "run", "test:e2e:report:pdf"])
      .withExec(["bun", "run", "test:e2e:dual-voice"])
      .withExec(["bun", "run", "test:e2e:interp:real"])
      .withExec(["bun", "run", "test:e2e:interp:heal:real"])
      .withExec(["bun", "run", "test:e2e:chat:rag:real"])
      .withExec(["bun", "run", "test:e2e:dashboard:agentic:real"])
  }
  private publicSource(commitSha: string): Directory {
    const history = dag
      .git(PAGES_TARGET.repositoryUrl)
      .commit(commitSha)
      .tree({ depth: 0, includeTags: true })
    return dag.foundation().source(history, PAGES_TARGET.repository, commitSha)
  }
  private async materializedPublicSource(commitSha: string): Promise<Directory> {
    const source = this.publicSource(commitSha)
    await source.digest()
    return source
  }
  private async verifiedPublicSource(commitSha: string): Promise<Directory> {
    const source = await this.materializedPublicSource(commitSha)
    await dag.foundation().guard(source, PAGES_TARGET.repository, commitSha).sync()
    return source
  }
  private releaseArtifact(source: Directory, signed: Container): ReleaseArtifact {
    const clean = this.withoutSigningSecrets(signed)
    const dist = clean.directory(DIST)
    const functions = dag.directory().withFile(
      PAGES_TARGET.functionFiles[0],
      source.file("frontend/apps/web/functions/api/feedback.ts"),
    )
    const roots = dag
      .directory()
      .withDirectory(PAGES_TARGET.deployRoot, dist)
      .withDirectory("functions", functions)
    return { dist, roots }
  }
  private pagesFunctionsProof(roots: Directory, expectedSha: string): Container {
    const derived = this.pagesFunctionsBuild(roots).directory("/derived")
    const staged = roots
      .directory(PAGES_TARGET.deployRoot)
      .withFile("_worker.js", derived.file("_worker.js"))
      .withFile("_routes.json", derived.file("_routes.json"))
    const closedRoots = roots.withNewDirectory(".wrangler")
    return this.pagesFunctionsBase()
      .withMountedDirectory("/project", closedRoots, { readOnly: true })
      .withMountedTemp("/project/.wrangler")
      .withMountedTemp("/run/functions-cache")
      .withMountedTemp("/run/functions-config")
      .withEnvVariable("WRANGLER_CACHE_DIR", "/run/functions-cache")
      .withEnvVariable("XDG_CONFIG_HOME", "/run/functions-config")
      .withFile("/compiled/_worker.js", staged.file("_worker.js"))
      .withFile("/compiled/_routes.json", staged.file("_routes.json"))
      .withFile("/compiled/_build-metadata.json", derived.file("_build-metadata.json"))
      .withWorkdir("/project")
      .withEnvVariable("EXPECTED_SHA", expectedSha)
      .withExec(["bash", "-c", this.pagesFunctionsDryRunScript()])
  }
  private providerDeploy(
    envelope: Directory,
    githubToken: Secret,
    cloudflareApiToken: Secret,
    cloudflareAccountId: Secret,
    request: ProviderRequest,
  ): PagesEvidence {
    return dag.cloudflarePages().deploy(
      envelope,
      githubToken,
      cloudflareApiToken,
      cloudflareAccountId,
      request.workflowRunId,
      request.runAttempt,
      request.repository,
      request.project,
      request.productionBranch,
      request.liveDomain,
      request.deployRoot,
      request.domains,
      request.consumerIdentity,
      request.producingIdentity,
      request.allowedRoots,
      { pagesFunctions: request.pagesFunctions },
    )
  }
  private async providerIdentity(
    evidence: PagesEvidence,
    source: GreenMainEvidence,
  ) {
    const [
      provider,
      deploymentId,
      deploymentUrl,
      project,
      repository,
      branch,
      sourceSha,
      workflowRunId,
      runAttempt,
    ] = await Promise.all([
      evidence.provider(),
      evidence.deploymentId(),
      evidence.deploymentUrl(),
      evidence.project(),
      evidence.repository(),
      evidence.branch(),
      evidence.sourceSha(),
      evidence.workflowRunId(),
      evidence.runAttempt(),
    ])
    return validateProviderEvidence({
      provider,
      deploymentId,
      deploymentUrl,
      project,
      repository,
      branch,
      sourceSha,
      workflowRunId,
      runAttempt,
    }, source)
  }
  private async verifyReleased(
    artifact: ReleaseArtifact,
    evidence: GreenMainEvidence,
  ): Promise<string> {
    const verified = this.verifyLive(evidence.commitSha, artifact.dist)
      .withExec(["bash", "-c", this.indexNowScript("/artifact")])
    return (await verified.stdout()).trim()
  }
  private signedBuild(
    source: Directory,
    privateKey: Secret,
    publicKey: Secret,
    expectedSha: string,
    bundleVersion?: string,
    bundleSequence?: number,
  ): Container {
    let build = this.releaseBase(source)
      .withMountedTemp(KEYS)
      .withSecretVariable("BUNDLE_PRIVATE_KEY_B64", privateKey)
      .withSecretVariable("BUNDLE_PUBLIC_KEY_B64", publicKey)
      .withEnvVariable("EXPECTED_SHA", expectedSha)
    if (bundleVersion !== undefined) {
      build = build.withEnvVariable("BUNDLE_VERSION_ARG", bundleVersion)
    }
    if (bundleSequence !== undefined) {
      build = build.withEnvVariable("BUNDLE_SEQUENCE_ARG", String(bundleSequence))
    }
    return build.withExec(["bash", "-c", this.productionBuildScript()])
  }
  private withoutSigningSecrets(container: Container): Container {
    return container
      .withoutSecretVariable("BUNDLE_PRIVATE_KEY_B64")
      .withoutSecretVariable("BUNDLE_PUBLIC_KEY_B64")
      .withoutMount(KEYS)
  }
  private productionBuildScript(): string {
    return `set -euo pipefail
printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "expected SHA must be 40 lowercase hex characters" >&2; exit 2; }
cleanup() {
  if [ -f "${KEYS}/private.key" ]; then shred -f -n 3 -z --remove "${KEYS}/private.key"; fi
  rm -rf "${KEYS}/"*
}
trap cleanup EXIT
umask 077
printf '%s' "$BUNDLE_PRIVATE_KEY_B64" | base64 -d > "${KEYS}/private.key"
printf '%s' "$BUNDLE_PUBLIC_KEY_B64" | base64 -d > "${KEYS}/public.key"
chmod 600 "${KEYS}/private.key"
export BUILD_COMMIT="$EXPECTED_SHA" PRODUCTION_KEYS_DIR="${KEYS}"
if [ -n "\${BUNDLE_VERSION_ARG:-}" ] && [ -n "\${BUNDLE_SEQUENCE_ARG:-}" ]; then
  export BUNDLE_VERSION="$BUNDLE_VERSION_ARG" BUNDLE_SEQUENCE="$BUNDLE_SEQUENCE_ARG"
else
  rm -rf /tmp/almamesh-history
  git clone --quiet --filter=blob:none --no-checkout https://github.com/hseshadr/almamesh.git /tmp/almamesh-history
  git -C /tmp/almamesh-history fetch --quiet origin "$EXPECTED_SHA"
  export BUNDLE_SEQUENCE="$(git -C /tmp/almamesh-history rev-list --count "$EXPECTED_SHA")"
  export BUNDLE_VERSION="$(git -C /tmp/almamesh-history describe --tags --abbrev=0 "$EXPECTED_SHA" 2>/dev/null || printf '0.0.0+%s' "\${EXPECTED_SHA:0:7}")"
  export BUNDLE_LIVE_URL="${LIVE_ORIGIN}/bundle/latest"
fi
bash scripts/build-prod.sh`
  }
  private dryRunBuildScript(): string {
    return `set -euo pipefail
printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "expected SHA must be 40 lowercase hex characters" >&2; exit 2; }
cleanup() {
  if [ -f "${KEYS}/private.key" ]; then shred -f -n 3 -z --remove "${KEYS}/private.key"; fi
  rm -rf "${KEYS}/"*
}
trap cleanup EXIT
(cd ${ROOT}/backend && uv run almamesh-bundle keygen "${KEYS}")
export BUILD_COMMIT="$EXPECTED_SHA" PRODUCTION_KEYS_DIR="${KEYS}"
export BUNDLE_VERSION="dagger-dry-run" BUNDLE_SEQUENCE="1"
bash scripts/build-prod.sh`
  }
  private pagesFunctionsDryRunScript(): string {
    return `set -euo pipefail
test "$(wrangler --version)" = "${WRANGLER_VERSION}"
test -f /compiled/_worker.js
test -f /compiled/_routes.json
test -f /compiled/_build-metadata.json
wrangler pages dev dist --ip 127.0.0.1 --port 8788 --compatibility-date=${WRANGLER_COMPATIBILITY_DATE} >/tmp/wrangler-pages.log 2>&1 &
pid=$!
stop_server() {
  if ! kill -0 "$pid" 2>/dev/null; then wait "$pid" 2>/dev/null || true; return 0; fi
  kill -TERM "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid" 2>/dev/null || true; return 0; fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || return 1
  wait "$pid" 2>/dev/null || true
  ! kill -0 "$pid" 2>/dev/null
}
cleanup() {
  status=$?
  trap - EXIT
  if ! stop_server; then cat /tmp/wrangler-pages.log >&2; exit 1; fi
  if [ "$status" -ne 0 ]; then cat /tmp/wrangler-pages.log >&2; fi
  exit "$status"
}
trap cleanup EXIT
feedback_verified=""
export EXPECTED_BUNDLE=$(node -e 'const p=JSON.parse(require("fs").readFileSync("dist/bundle/latest","utf8"));if(!/^[0-9a-f]{64}$/.test(p.manifest_hash)||!Number.isSafeInteger(p.sequence))process.exit(1);process.stdout.write(p.manifest_hash+":"+p.sequence)')
for _ in $(seq 1 60); do
  if node -e 'Promise.all([fetch("http://127.0.0.1:8788/build.json"),fetch("http://127.0.0.1:8788/bundle/latest"),fetch("http://127.0.0.1:8788/api/feedback",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})]).then(async([buildResponse,bundleResponse,response])=>{const build=await buildResponse.json();const bundle=await bundleResponse.json();const body=await response.json();const actualBundle=bundle.manifest_hash+":"+bundle.sequence;if(buildResponse.status!==200||build.commit!==process.env.EXPECTED_SHA||bundleResponse.status!==200||actualBundle!==process.env.EXPECTED_BUNDLE||response.status!==400||JSON.stringify(body)!==JSON.stringify({ok:false,error:"invalid_page"}))process.exit(1)}).catch(()=>process.exit(75))'; then
    feedback_verified=1
    break
  else
    request_status=$?
    [ "$request_status" -eq 75 ] || exit "$request_status"
  fi
  kill -0 "$pid" 2>/dev/null || { cat /tmp/wrangler-pages.log >&2; exit 1; }
  sleep 1
done
test "$feedback_verified" = "1"
echo "Wrangler Pages Functions dry-run verified closed feedback route for $EXPECTED_SHA"`
  }
  private indexNowScript(artifact: string): string {
    return releaseIndexNowScript(artifact)
  }
  private liveVerificationScript(artifact: string): string {
    return releaseLiveVerificationScript(
      artifact,
      LIVE_ORIGIN,
      12,
      10,
      `https://${PAGES_TARGET.domains[0]}`,
    )
  }
  private localPreview(container: Container, output: string, commands: readonly string[]): Container {
    const preview = `./node_modules/.bin/vite preview --outDir ${output} --host 127.0.0.1 --port 4199 --strictPort`
    return this.localServer(container, preview, 4199, commands)
  }
  private localServer(container: Container, server: string, port: number, commands: readonly string[]): Container {
    return container.withExec(["bash", "-c", `set -euo pipefail
${server} &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in {1..60}; do curl -fsS -o /dev/null http://127.0.0.1:${port} && break; kill -0 "$pid"; sleep 1; done; curl -fsS -o /dev/null http://127.0.0.1:${port}
${commands.join("\n")}`])
  }
  private preview(
    container: Container,
    output: string,
    port: number,
    allowedHost?: string,
  ): Service {
    let server = container.withExec([
      "sed",
      "-i",
      "s/; upgrade-insecure-requests//g",
      "public/_headers",
    ])
    if (allowedHost) {
      server = server.withEnvVariable("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", allowedHost)
    }
    return server.withExposedPort(port).asService({
      args: [
        "./node_modules/.bin/vite",
        "preview",
        "--outDir",
        output,
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
        "--strictPort",
      ],
    })
  }
  private async liveSmoke(passes: readonly SmokePass[], previousUrl?: string): Promise<SmokeRun[]> {
    const runs: SmokeRun[] = []
    for (const pass of passes) runs.push(await this.liveSmokePass(pass, previousUrl))
    return runs
  }
  private async liveSmokePass(pass: SmokePass, previousUrl?: string): Promise<SmokeRun> {
    let runner = this.browserToolchain()
      .withWorkdir(WEB)
      .withExec(["bun", "x", "playwright", "install", "--with-deps", "chromium"])
      .withEnvVariable("LIVE_SMOKE_ORIGIN", LIVE_ORIGIN)
      .withEnvVariable("LIVE_SMOKE_RUN", randomUUID())
    if (previousUrl !== undefined) runner = runner.withEnvVariable("LIVE_SMOKE_PREVIOUS_URL", previousUrl)
    const run = runner.withExec(
      ["bun", "run", "test:e2e:live-smoke", "--grep", `@${pass}`],
      { expect: ReturnType.Any },
    )
    const [exitCode, stdout, stderr] = await Promise.all([run.exitCode(), run.stdout(), run.stderr()])
    const output = `${stdout}\n${stderr}`.split("\n").slice(-SMOKE_OUTPUT_LINES).join("\n")
    return { pass, passed: exitCode === 0, output }
  }
}
