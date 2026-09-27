import { describe, expect, spyOn, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PAGES_TARGET,
  deliverProduction,
  indexNowProgram,
  indexNowScript,
  liveVerificationScript,
  parseGreenMainEvidence,
  releaseIdentities,
  RETURNING_PASS_NOT_WIRED,
  validateProviderEvidence,
  type DeliveryPort,
  type SmokePass,
  type SmokeRun,
} from "../dagger/src/deployment.ts"

const commitSha = "1".repeat(40)
const centralSha = "2".repeat(40)

function serializedEvidence(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    repository: "hseshadr/almamesh",
    branch: "main",
    commit_sha: commitSha,
    workflow_run_id: "781",
    run_attempt: 3,
    ...overrides,
  })
}

describe("immutable AlmaMesh Pages target", () => {
  test("closes the shared provider boundary over the static site and Pages Functions", () => {
    expect(PAGES_TARGET).toEqual({
      repository: "hseshadr/almamesh",
      repositoryUrl: "https://github.com/hseshadr/almamesh.git",
      project: "almamesh",
      productionBranch: "main",
      liveDomain: "almamesh.com",
      domains: ["www.almamesh.com"],
      deployRoot: "dist",
      allowedRoots: ["dist", "functions"],
      functionFiles: ["api/feedback.ts"],
      pagesFunctions: true,
    })
  })
})

describe("protected Dagger evidence", () => {
  test("binds the exact repository, main SHA, workflow run, and attempt", () => {
    expect(parseGreenMainEvidence(serializedEvidence(), commitSha, "781", 3)).toEqual({
      repository: "hseshadr/almamesh",
      branch: "main",
      commitSha,
      workflowRunId: "781",
      runAttempt: 3,
    })
  })

  test.each([
    ["wrong repository", { repository: "attacker/fork" }],
    ["wrong branch", { branch: "preview" }],
    ["wrong SHA", { commit_sha: "0".repeat(40) }],
    ["abbreviated SHA", { commit_sha: commitSha.slice(0, 12) }],
    ["non-numeric run", { workflow_run_id: "run-781" }],
    ["zero run", { workflow_run_id: "0" }],
    ["boolean attempt", { run_attempt: true }],
    ["zero attempt", { run_attempt: 0 }],
    ["fractional attempt", { run_attempt: 1.5 }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseGreenMainEvidence(serializedEvidence(overrides), commitSha, "781", 3))
      .toThrow()
  })

  test("rejects malformed and non-object serialization", () => {
    for (const value of ["not-json", "null", "[]"]) {
      expect(() => parseGreenMainEvidence(value, commitSha, "781", 3)).toThrow()
    }
  })

  test.each([
    ["missing repository", { repository: undefined }],
    ["numeric branch", { branch: 7 }],
    ["numeric workflow run", { workflow_run_id: 781 }],
    ["missing attempt", { run_attempt: undefined }],
  ])("rejects schema with %s", (_name, overrides) => {
    expect(() => parseGreenMainEvidence(serializedEvidence(overrides), commitSha, "781", 3))
      .toThrow("Foundation")
  })

  test.each([
    ["wrong caller run", "782", 3],
    ["non-numeric caller run", "run-781", 3],
    ["wrong caller attempt", "781", 4],
    ["boolean caller attempt", "781", true],
  ])("rejects %s", (_name, workflowRunId, runAttempt) => {
    expect(() => parseGreenMainEvidence(
      serializedEvidence(),
      commitSha,
      workflowRunId as string,
      runAttempt as number,
    )).toThrow()
  })

  test("derives closed Foundation identities from the protected run", () => {
    const evidence = parseGreenMainEvidence(serializedEvidence(), commitSha, "781", 3)
    expect(releaseIdentities(evidence, centralSha)).toEqual({
      consumer: `hseshadr/almamesh@${commitSha}`,
      producer: `${centralSha}:781`,
    })
  })

  test.each(["", "2".repeat(39), "G".repeat(40)])(
    "rejects noncanonical central identity %s",
    (value) => {
      const evidence = parseGreenMainEvidence(serializedEvidence(), commitSha, "781", 3)
      expect(() => releaseIdentities(evidence, value)).toThrow()
    },
  )
})

describe("single-transaction delivery orchestration", () => {
  test("orders binding, signed build, preview, envelope, one deploy, reload, then live proof", async () => {
    const events: string[] = []
    let evidenceIdCalls = 0
    let reloadCalls = 0
    const result = await deliverProduction({
      greenMain: async () => {
        events.push("green-main")
        return serializedEvidence()
      },
      bindSource: async () => {
        events.push("bind-source")
        return "bound-source"
      },
      guardSource: async (source) => {
        expect(source).toBe("bound-source")
        events.push("guard-source")
      },
      buildRelease: async (source) => {
        expect(source).toBe("bound-source")
        events.push("signed-build")
        return "closed-release"
      },
      verifyPreview: async (artifact) => {
        expect(artifact).toBe("closed-release")
        events.push("preview")
      },
      createEnvelope: async (artifact, identities, roots) => {
        expect(artifact).toBe("closed-release")
        expect(identities).toEqual({
          consumer: `hseshadr/almamesh@${commitSha}`,
          producer: `${centralSha}:781`,
        })
        expect(roots).toEqual(["dist", "functions"])
        events.push("envelope")
        return "closed-envelope"
      },
      deployPages: (envelope, request) => {
        expect(envelope).toBe("closed-envelope")
        expect(request).toEqual({
          workflowRunId: "781",
          runAttempt: 3,
          repository: "hseshadr/almamesh",
          project: "almamesh",
          productionBranch: "main",
          liveDomain: "almamesh.com",
          deployRoot: "dist",
          domains: ["www.almamesh.com"],
          consumerIdentity: `hseshadr/almamesh@${commitSha}`,
          producingIdentity: `${centralSha}:781`,
          allowedRoots: ["dist", "functions"],
          pagesFunctions: true,
        })
        events.push("deploy")
        return "lazy-evidence"
      },
      evidenceId: async (evidence) => {
        expect(evidence).toBe("lazy-evidence")
        evidenceIdCalls += 1
        events.push("evidence-id")
        return "evidence-id"
      },
      reloadEvidence: (id) => {
        expect(id).toBe("evidence-id")
        reloadCalls += 1
        events.push("reload")
        return "stored-evidence"
      },
      providerIdentity: async (stored) => {
        expect(stored).toBe("stored-evidence")
        events.push("provider-identity")
        return { deploymentId: "deployment-id", deploymentUrl: "https://deployment.pages.dev" }
      },
      verifyLive: async (artifact, evidence, provider) => {
        expect(artifact).toBe("closed-release")
        expect(evidence.workflowRunId).toBe("781")
        expect(provider.deploymentId).toBe("deployment-id")
        events.push("live-static-bundle-feedback")
        return "live proof"
      },
      smokeLive: async (passes, previousUrl) => {
        expect(passes).toEqual(["fresh"])
        expect(previousUrl).toBeUndefined()
        events.push("live-smoke")
        return [{ pass: "fresh", passed: true, output: "fresh ok" }]
      },
    }, commitSha, "781", 3, centralSha)

    expect(evidenceIdCalls).toBe(1)
    expect(reloadCalls).toBe(1)
    expect(events).toEqual([
      "green-main",
      "bind-source",
      "guard-source",
      "signed-build",
      "preview",
      "envelope",
      "deploy",
      "evidence-id",
      "reload",
      "provider-identity",
      "live-static-bundle-feedback",
      "live-smoke",
    ])
    expect(result).toEqual({
      deploymentId: "deployment-id",
      deploymentUrl: "https://deployment.pages.dev",
      liveProof: `live proof\n${RETURNING_PASS_NOT_WIRED}\nLive smoke passed: fresh`,
    })
  })

  test("a preview failure prevents envelope creation and provider mutation", async () => {
    const events: string[] = []
    const previewFailure = new Error("preview identity differs")
    const port = failClosedPort(events)
    port.verifyPreview = async () => {
      events.push("preview")
      throw previewFailure
    }

    await expect(deliverProduction(port, commitSha, "781", 3, centralSha))
      .rejects.toBe(previewFailure)
    expect(events).toEqual([
      "green-main",
      "bind-source",
      "guard-source",
      "signed-build",
      "preview",
    ])
  })

  test("an envelope failure prevents the provider from being constructed", async () => {
    const events: string[] = []
    const envelopeFailure = new Error("artifact closure differs")
    const port = failClosedPort(events)
    port.createEnvelope = async () => {
      events.push("envelope")
      throw envelopeFailure
    }

    await expect(deliverProduction(port, commitSha, "781", 3, centralSha))
      .rejects.toBe(envelopeFailure)
    expect(events).not.toContain("deploy")
  })
})

describe("materialized provider evidence", () => {
  const sourceEvidence = {
    repository: "hseshadr/almamesh",
    branch: "main",
    commitSha,
    workflowRunId: "781",
    runAttempt: 3,
  }
  const providerEvidence = {
    provider: "cloudflare-pages",
    deploymentId: "deployment-id",
    deploymentUrl: "https://deployment-id.almamesh.pages.dev",
    project: "almamesh",
    repository: "hseshadr/almamesh",
    branch: "main",
    sourceSha: commitSha,
    workflowRunId: "781",
    runAttempt: 3,
  }

  test("returns only the exact deployment identity after binding every source field", () => {
    expect(validateProviderEvidence(providerEvidence, sourceEvidence)).toEqual({
      deploymentId: "deployment-id",
      deploymentUrl: "https://deployment-id.almamesh.pages.dev",
    })
  })

  test.each([
    ["provider", { provider: "github-pages" }],
    ["project", { project: "other" }],
    ["repository", { repository: "attacker/almamesh" }],
    ["branch", { branch: "preview" }],
    ["source SHA", { sourceSha: "0".repeat(40) }],
    ["workflow run", { workflowRunId: "782" }],
    ["run attempt", { runAttempt: 4 }],
    ["deployment URL", { deploymentUrl: "http://deployment.pages.dev" }],
    ["foreign project URL", { deploymentUrl: "https://deployment-id.other.pages.dev" }],
    ["deployment ID", { deploymentId: "" }],
  ])("rejects mismatched %s", (_name, overrides) => {
    expect(() => validateProviderEvidence(
      { ...providerEvidence, ...overrides },
      sourceEvidence,
    )).toThrow("provider evidence")
  })
})

function failClosedPort(events: string[]) {
  return {
    greenMain: async () => {
      events.push("green-main")
      return serializedEvidence()
    },
    bindSource: async () => {
      events.push("bind-source")
      return "bound-source"
    },
    guardSource: async () => {
      events.push("guard-source")
    },
    buildRelease: async () => {
      events.push("signed-build")
      return "closed-release"
    },
    verifyPreview: async () => {
      events.push("preview")
    },
    createEnvelope: async () => {
      events.push("envelope")
      return "closed-envelope"
    },
    deployPages: () => {
      events.push("deploy")
      return "lazy-evidence"
    },
    evidenceId: async () => "evidence-id",
    reloadEvidence: () => "stored-evidence",
    providerIdentity: async () => ({
      deploymentId: "deployment-id",
      deploymentUrl: "https://deployment.pages.dev",
    }),
    verifyLive: async () => "live proof",
    smokeLive: async (passes: readonly SmokePass[]): Promise<SmokeRun[]> => {
      events.push(`live-smoke:${passes.join(",")}`)
      return passes.map((pass) => ({ pass, passed: true, output: `${pass} ok` }))
    },
  } as DeliveryPort<string, string, string, string, string>
}

const PREVIOUS_URL = "https://11111111.almamesh.pages.dev"

describe("post-deploy live smoke", () => {
  test("without a previous deployment only the fresh pass runs, and the proof says so loudly", async () => {
    const events: string[] = []
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    const result = await deliverProduction(failClosedPort(events), commitSha, "781", 3, centralSha)
    expect(warn).toHaveBeenCalledWith(RETURNING_PASS_NOT_WIRED)
    warn.mockRestore()
    expect(events.at(-1)).toBe("live-smoke:fresh")
    expect(result.liveProof).toContain(RETURNING_PASS_NOT_WIRED)
    expect(RETURNING_PASS_NOT_WIRED).toContain("returning-visitor pass NOT RUN")
  })

  test("a supplied previous deployment is read before the upload and drives the returning pass", async () => {
    const events: string[] = []
    const port = failClosedPort(events)
    let smokedWith: string | undefined
    port.previousProductionUrl = async () => {
      events.push("previous-production")
      return PREVIOUS_URL
    }
    const smoke = port.smokeLive
    port.smokeLive = async (passes, previousUrl) => {
      smokedWith = previousUrl
      return smoke(passes, previousUrl)
    }

    const result = await deliverProduction(port, commitSha, "781", 3, centralSha)
    expect(events.indexOf("previous-production")).toBeLessThan(events.indexOf("deploy"))
    expect(events.at(-1)).toBe("live-smoke:fresh,returning")
    expect(smokedWith).toBe(PREVIOUS_URL)
    expect(result.liveProof).toEndWith("Live smoke passed: fresh, returning")
  })

  test("a failed pass fails the delivery naming the pass and the live deployment", async () => {
    const events: string[] = []
    const port = failClosedPort(events)
    port.smokeLive = async () => [{ pass: "fresh", passed: false, output: "engine ready within 30000 ms" }]

    const failure = deliverProduction(port, commitSha, "781", 3, centralSha)
    await expect(failure).rejects.toThrow("Live smoke failed (fresh) on deployment deployment-id")
    await expect(failure).rejects.toThrow("engine ready within 30000 ms")
  })

  test("a requested pass that never reported is a failure, not a success", async () => {
    const events: string[] = []
    const port = failClosedPort(events)
    port.previousProductionUrl = async () => PREVIOUS_URL
    port.smokeLive = async () => [{ pass: "fresh", passed: true, output: "fresh ok" }]

    await expect(deliverProduction(port, commitSha, "781", 3, centralSha)).rejects.toThrow(
      "Live smoke failed (returning)",
    )
  })

  test("production changes go only through the central module: no repository code calls the Cloudflare API", () => {
    const dir = join(import.meta.dir, "..", "dagger", "src")
    const direct = readdirSync(dir).filter((name) => {
      const source = readFileSync(join(dir, name), "utf8")
      return source.includes("api.cloudflare.com") || source.includes("/rollback")
    })
    expect(direct).toEqual([])
  })

  test("an empty smoke report fails", async () => {
    const port = failClosedPort([])
    port.smokeLive = async () => []
    await expect(deliverProduction(port, commitSha, "781", 3, centralSha)).rejects.toThrow("Live smoke failed (fresh)")
  })
})

describe("non-writing live release proof", () => {
  test("rejects unsafe live-proof bounds before constructing a command", () => {
    expect(() => liveVerificationScript("/artifact", "file:///tmp/site"))
      .toThrow("scheme")
    expect(() => liveVerificationScript(
      "/artifact",
      "https://almamesh.com",
      1,
      0,
      "file:///tmp/alias",
    )).toThrow("alias")
    expect(() => liveVerificationScript("/artifact", "https://almamesh.com", 0))
      .toThrow("attempt count")
    expect(() => liveVerificationScript("/artifact", "https://almamesh.com", 1, 61))
      .toThrow("retry delay")
  })

  test("uses built-in fetch with bounded timeouts", () => {
    const script = liveVerificationScript(
      "/artifact",
      "https://almamesh.com",
      1,
      0,
      "https://www.almamesh.com",
    )
    expect(script).not.toContain("curl")
    expect(script).toContain("AbortSignal.timeout")
    expect(script).not.toContain('redirect: "follow"')
  })

  test("verifies the exact static identity, signed bundle, and invalid feedback route", async () => {
    const artifact = releaseArtifact()
    const feedbackRequests: Array<{ body: string; method: string }> = []
    const server = releaseServer(400, feedbackRequests)
    const alias = redirectServer(server.url.origin)
    try {
      const result = await runLiveProof(artifact, server.url.origin, alias.url.origin)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain("Live app, bundle, and feedback route identity verified")
      expect(feedbackRequests).toEqual([{ method: "POST", body: "{}" }])
    } finally {
      server.stop(true)
      alias.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("accepts a direct www 200 only when it serves the same release identity", async () => {
    const artifact = releaseArtifact()
    const apex = releaseServer(400, [])
    const alias = releaseServer(400, [])
    try {
      const result = await runLiveProof(artifact, apex.url.origin, alias.url.origin)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain("Live app, bundle, and feedback route identity verified")
    } finally {
      apex.stop(true)
      alias.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects a feedback probe that could have reached storage", async () => {
    const artifact = releaseArtifact()
    const feedbackRequests: Array<{ body: string; method: string }> = []
    const server = releaseServer(200, feedbackRequests)
    try {
      const result = await runLiveProof(artifact, server.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("feedback route did not reject the non-writing probe")
      expect(feedbackRequests).toEqual([{ method: "POST", body: "{}" }])
    } finally {
      server.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects a 400 response that is not the deterministic invalid-page proof", async () => {
    const artifact = releaseArtifact()
    const feedbackRequests: Array<{ body: string; method: string }> = []
    const server = releaseServer(400, feedbackRequests, { ok: false, error: "invalid_email" })
    try {
      const result = await runLiveProof(artifact, server.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("feedback route rejection body differed")
      expect(feedbackRequests).toEqual([{ method: "POST", body: "{}" }])
    } finally {
      server.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects a www alias that cannot resolve the exact release identity", async () => {
    const artifact = releaseArtifact()
    const feedbackRequests: Array<{ body: string; method: string }> = []
    const apex = releaseServer(400, feedbackRequests)
    const alias = releaseServer(400, [], undefined, "0".repeat(40))
    try {
      const result = await runLiveProof(artifact, apex.url.origin, alias.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("alias identity did not converge")
      expect(feedbackRequests).toEqual([])
    } finally {
      apex.stop(true)
      alias.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects a malicious www Location without making a second request", async () => {
    const artifact = releaseArtifact()
    const apex = releaseServer(400, [])
    const evilRequests: string[] = []
    const evil = requestRecorder(evilRequests)
    const alias = redirectServer(evil.url.origin)
    try {
      const result = await runLiveProof(artifact, apex.url.origin, alias.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("alias identity did not converge")
      expect(evilRequests).toEqual([])
    } finally {
      apex.stop(true)
      alias.stop(true)
      evil.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects any www redirect status other than the fixed 308 without following", async () => {
    const artifact = releaseArtifact()
    const apex = releaseServer(400, [])
    const targetRequests: string[] = []
    const target = requestRecorder(targetRequests)
    const alias = redirectServer(target.url.origin, 302)
    try {
      const result = await runLiveProof(artifact, apex.url.origin, alias.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("alias identity did not converge")
      expect(targetRequests).toEqual([])
    } finally {
      apex.stop(true)
      alias.stop(true)
      target.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })

  test("rejects an apex redirect without following it", async () => {
    const artifact = releaseArtifact()
    const targetRequests: string[] = []
    const target = requestRecorder(targetRequests)
    const apex = redirectServer(target.url.origin)
    try {
      const result = await runLiveProof(artifact, apex.url.origin)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("live application or bundle identity did not converge")
      expect(targetRequests).toEqual([])
    } finally {
      apex.stop(true)
      target.stop(true)
      rmSync(artifact, { recursive: true, force: true })
    }
  })
})

describe("nonfatal IndexNow tail", () => {
  test("uses one fixed endpoint, bounded signal, and exact public payload", async () => {
    const program = indexNowProgram()
    const fakeFetch = `globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(init.body)
      if (url !== "https://api.indexnow.org/indexnow") throw new Error("URL")
      if (init.redirect !== "error" || !init.signal) throw new Error("policy")
      if (payload.host !== "almamesh.com" || payload.key !== "${"a".repeat(32)}") throw new Error("identity")
      if (payload.keyLocation !== "https://almamesh.com/${"a".repeat(32)}.txt") throw new Error("key location")
      if (JSON.stringify(payload.urlList) !== JSON.stringify([
        "https://almamesh.com/",
        "https://almamesh.com/welcome",
        "https://almamesh.com/privacy",
        "https://almamesh.com/terms",
        "https://almamesh.com/data-deletion",
      ])) throw new Error("URLs")
      return { ok: true }
    }`
    const result = await runBunProgram(`${fakeFetch}\n${program}`, {
      INDEXNOW_KEY: "a".repeat(32),
    })
    expect(result.exitCode, result.stderr).toBe(0)
  })

  test("returns failure for a provider rejection without logging response content", async () => {
    const fakeFetch = "globalThis.fetch = async () => ({ ok: false })"
    const result = await runBunProgram(`${fakeFetch}\n${indexNowProgram()}`, {
      INDEXNOW_KEY: "a".repeat(32),
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })

  test("aborts a stalled request at the configured bound", async () => {
    const fakeFetch = `globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })`
    const started = performance.now()
    const result = await runBunProgram(`${fakeFetch}\n${indexNowProgram(20)}`, {
      INDEXNOW_KEY: "a".repeat(32),
    })
    expect(result.exitCode).not.toBe(0)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.stderr).toBe("")
  })

  test("keeps notification failure nonfatal and reports only a fixed message", () => {
    const artifact = mkdtempSync(join(tmpdir(), "almamesh-index-now-"))
    const fakeBin = mkdtempSync(join(tmpdir(), "almamesh-index-now-bin-"))
    writeFileSync(join(artifact, `${"a".repeat(32)}.txt`), "a".repeat(32))
    writeFileSync(join(fakeBin, "bun"), "#!/bin/sh\nexit \"${FAKE_BUN_STATUS:-0}\"\n")
    chmodSync(join(fakeBin, "bun"), 0o755)
    try {
      const success = Bun.spawnSync(["bash", "-c", indexNowScript(artifact)], {
        env: { ...Bun.env, PATH: `${fakeBin}:${Bun.env.PATH}`, FAKE_BUN_STATUS: "0" },
      })
      expect(success.exitCode).toBe(0)
      expect(success.stderr.toString()).toBe("")
      const failure = Bun.spawnSync(["bash", "-c", indexNowScript(artifact)], {
        env: { ...Bun.env, PATH: `${fakeBin}:${Bun.env.PATH}`, FAKE_BUN_STATUS: "9" },
      })
      expect(failure.exitCode).toBe(0)
      expect(failure.stderr.toString()).toBe("IndexNow notification failed (non-fatal)\n")
    } finally {
      rmSync(artifact, { recursive: true, force: true })
      rmSync(fakeBin, { recursive: true, force: true })
    }
  })
})

function releaseArtifact(): string {
  const artifact = mkdtempSync(join(tmpdir(), "almamesh-live-proof-"))
  mkdirSync(join(artifact, "bundle"))
  writeFileSync(join(artifact, "bundle/latest"), JSON.stringify({
    manifest_hash: "a".repeat(64),
    sequence: 17,
  }))
  return artifact
}

function releaseServer(
  feedbackStatus: number,
  feedbackRequests: Array<{ body: string; method: string }>,
  feedbackBody?: { ok: boolean; error?: string },
  buildSha = commitSha,
) {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/build.json") return Response.json({ commit: buildSha })
      if (path === "/bundle/latest") {
        return Response.json({ manifest_hash: "a".repeat(64), sequence: 17 })
      }
      if (path === "/api/feedback") {
        feedbackRequests.push({ method: request.method, body: await request.text() })
        return Response.json(
          feedbackBody ?? (feedbackStatus === 400
            ? { ok: false, error: "invalid_page" }
            : { ok: true }),
          { status: feedbackStatus },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
}

function redirectServer(destinationOrigin: string, status = 308) {
  return Bun.serve({
    port: 0,
    fetch: (request) => {
      const incoming = new URL(request.url)
      const location = new URL(`${incoming.pathname}${incoming.search}`, destinationOrigin)
      return new Response(null, { status, headers: { location: location.href } })
    },
  })
}

function requestRecorder(requests: string[]) {
  return Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(request.url)
      return Response.json({ commit: commitSha })
    },
  })
}

async function runLiveProof(artifact: string, origin: string, aliasOrigin?: string) {
  const process = Bun.spawn([
    "bash",
    "-c",
    liveVerificationScript(artifact, origin, 1, 0, aliasOrigin),
  ], {
    env: { ...Bun.env, EXPECTED_SHA: commitSha },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function runBunProgram(program: string, env: Record<string, string>) {
  const process = Bun.spawn(["bun", "-e", program], {
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}
