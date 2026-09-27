const FULL_SHA = /^[0-9a-f]{40}$/
const POSITIVE_INTEGER = /^[1-9][0-9]*$/

export interface GreenMainEvidence {
  repository: string
  branch: string
  commitSha: string
  workflowRunId: string
  runAttempt: number
}

export interface ReleaseIdentities {
  consumer: string
  producer: string
}

export interface ProviderIdentity {
  deploymentId: string
  deploymentUrl: string
}

export interface ProviderEvidenceFields extends ProviderIdentity {
  provider: string
  project: string
  repository: string
  branch: string
  sourceSha: string
  workflowRunId: string
  runAttempt: number
}

export interface ProviderRequest extends Record<string, unknown> {
  workflowRunId: string
  runAttempt: number
  repository: string
  project: string
  productionBranch: string
  liveDomain: string
  deployRoot: string
  domains: string[]
  consumerIdentity: string
  producingIdentity: string
  allowedRoots: string[]
  pagesFunctions: boolean
}

export interface DeliveryResult extends ProviderIdentity {
  liveProof: string
}

/** The two post-deploy smoke passes, in the order they run. */
export const SMOKE_PASSES = Object.freeze(["fresh", "returning"] as const)
export type SmokePass = (typeof SMOKE_PASSES)[number]

/** One Playwright smoke pass against the live origin. */
export interface SmokeRun {
  pass: SmokePass
  passed: boolean
  output: string
}

export interface DeliveryPort<Source, Artifact, Envelope, LazyEvidence, StoredEvidence> {
  greenMain(): Promise<string>
  bindSource(evidence: GreenMainEvidence): Promise<Source>
  guardSource(source: Source, evidence: GreenMainEvidence): Promise<void>
  buildRelease(source: Source, evidence: GreenMainEvidence): Promise<Artifact>
  verifyPreview(artifact: Artifact, evidence: GreenMainEvidence): Promise<void>
  createEnvelope(
    artifact: Artifact,
    identities: ReleaseIdentities,
    allowedRoots: readonly string[],
  ): Promise<Envelope>
  deployPages(envelope: Envelope, request: ProviderRequest): LazyEvidence
  evidenceId(evidence: LazyEvidence): Promise<string>
  reloadEvidence(id: string): StoredEvidence
  providerIdentity(
    evidence: StoredEvidence,
    source: GreenMainEvidence,
  ): Promise<ProviderIdentity>
  verifyLive(
    artifact: Artifact,
    evidence: GreenMainEvidence,
    provider: ProviderIdentity,
  ): Promise<string>
  /** The production deployment live BEFORE this release (central module, read-only). */
  previousProduction(): Promise<ProviderIdentity>
  /** Run the given smoke passes against the live origin, in order. */
  smokeLive(passes: readonly SmokePass[], previousUrl: string): Promise<SmokeRun[]>
  /** Roll production back to `deploymentId` through the central module. */
  rollbackTo(deploymentId: string): Promise<RollbackEvidence>
}

/** The central module's non-secret proof of a completed rollback. */
export interface RollbackEvidence {
  fromDeploymentId: string
  toDeploymentId: string
  liveDeploymentId: string
}

export const PAGES_TARGET = Object.freeze({
  repository: "hseshadr/almamesh",
  repositoryUrl: "https://github.com/hseshadr/almamesh.git",
  project: "almamesh",
  productionBranch: "main",
  liveDomain: "almamesh.com",
  domains: Object.freeze(["www.almamesh.com"]),
  deployRoot: "dist",
  allowedRoots: Object.freeze(["dist", "functions"]),
  functionFiles: Object.freeze(["api/feedback.ts"]),
  pagesFunctions: true,
})

export function parseGreenMainEvidence(
  serialization: string,
  expectedSha: string,
  expectedWorkflowRunId: string,
  expectedRunAttempt: number,
): GreenMainEvidence {
  requireFullSha(expectedSha, "expected SHA")
  requireAttempt(expectedWorkflowRunId, expectedRunAttempt, "caller")
  const value = parseObject(serialization)
  const repository = requiredString(value, "repository")
  const branch = requiredString(value, "branch")
  const commitSha = requiredString(value, "commit_sha")
  const workflowRunId = requiredString(value, "workflow_run_id")
  const runAttempt = value.run_attempt
  requireSource(repository, branch, commitSha, expectedSha)
  requireAttempt(workflowRunId, runAttempt, "Foundation")
  if (workflowRunId !== expectedWorkflowRunId || runAttempt !== expectedRunAttempt) {
    throw new Error("Foundation protected attempt identity differs")
  }
  return { repository, branch, commitSha, workflowRunId, runAttempt }
}

export function releaseIdentities(
  evidence: GreenMainEvidence,
  centralSha: string,
): ReleaseIdentities {
  requireFullSha(centralSha, "central module SHA")
  return {
    consumer: `${evidence.repository}@${evidence.commitSha}`,
    producer: `${centralSha}:${evidence.workflowRunId}`,
  }
}

export function validateProviderEvidence(
  provider: ProviderEvidenceFields,
  source: GreenMainEvidence,
): ProviderIdentity {
  const exact = provider.provider === "cloudflare-pages"
    && provider.project === PAGES_TARGET.project
    && provider.repository === source.repository
    && provider.branch === source.branch
    && provider.sourceSha === source.commitSha
    && provider.workflowRunId === source.workflowRunId
    && provider.runAttempt === source.runAttempt
  if (!exact || provider.deploymentId.length === 0 || !validDeploymentUrl(provider.deploymentUrl)) {
    throw new Error("Cloudflare provider evidence differs")
  }
  return {
    deploymentId: provider.deploymentId,
    deploymentUrl: provider.deploymentUrl,
  }
}

export async function deliverProduction<Source, Artifact, Envelope, LazyEvidence, StoredEvidence>(
  port: DeliveryPort<Source, Artifact, Envelope, LazyEvidence, StoredEvidence>,
  expectedSha: string,
  workflowRunId: string,
  runAttempt: number,
  centralSha: string,
): Promise<DeliveryResult> {
  const serialization = await port.greenMain()
  const evidence = parseGreenMainEvidence(
    serialization,
    expectedSha,
    workflowRunId,
    runAttempt,
  )
  const identities = releaseIdentities(evidence, centralSha)
  const source = await port.bindSource(evidence)
  await port.guardSource(source, evidence)
  const artifact = await port.buildRelease(source, evidence)
  await port.verifyPreview(artifact, evidence)
  const envelope = await port.createEnvelope(artifact, identities, PAGES_TARGET.allowedRoots)
  const previous = await port.previousProduction()
  if (previous.deploymentId.length === 0 || !validDeploymentUrl(previous.deploymentUrl)) {
    throw new Error("previous production deployment differs")
  }
  const lazyEvidence = port.deployPages(envelope, providerRequest(evidence, identities))
  const evidenceId = await port.evidenceId(lazyEvidence)
  const storedEvidence = port.reloadEvidence(evidenceId)
  const provider = await port.providerIdentity(storedEvidence, evidence)
  const liveProof = await port.verifyLive(artifact, evidence, provider)
  const smoke = await port.smokeLive(SMOKE_PASSES, previous.deploymentUrl)
  const failed = failedSmokePasses(SMOKE_PASSES, smoke)
  if (failed.length > 0) await rollBackAndFail(port, previous, provider.deploymentId, failed, smoke)
  return { ...provider, liveProof: `${liveProof}\nLive smoke passed: ${SMOKE_PASSES.join(", ")}` }
}

async function rollBackAndFail<S, A, E, L, T>(
  port: DeliveryPort<S, A, E, L, T>,
  previous: ProviderIdentity,
  releasedId: string,
  failed: readonly SmokePass[],
  runs: readonly SmokeRun[],
): Promise<never> {
  const detail = runs.filter((run) => !run.passed).map((run) => `--- ${run.pass} ---\n${run.output}`).join("\n")
  const outcome = await rollBack(port, previous, releasedId)
  throw new Error(`Live smoke failed (${failed.join(", ")}) on deployment ${releasedId}; ${outcome}\n${detail}`)
}

/** Roll back through the central module, then prove recovery with a fresh smoke. */
async function rollBack<S, A, E, L, T>(
  port: DeliveryPort<S, A, E, L, T>,
  previous: ProviderIdentity,
  releasedId: string,
): Promise<string> {
  try {
    const evidence = await port.rollbackTo(previous.deploymentId)
    const restored = evidence.fromDeploymentId === releasedId
      && evidence.toDeploymentId === previous.deploymentId
      && evidence.liveDeploymentId === previous.deploymentId
    if (!restored) throw new Error("rollback evidence differs")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `rollback FAILED, ${releasedId} may still be live: ${reason}`
  }
  const rolledBack = `production rolled back from ${releasedId} to ${previous.deploymentId}`
  const recovery = await port.smokeLive(["fresh"], previous.deploymentUrl)
  if (failedSmokePasses(["fresh"], recovery).length === 0) return `${rolledBack}; recovery smoke (fresh) passed`
  return `${rolledBack}; recovery smoke (fresh) FAILED\n${recovery.map((run) => run.output).join("\n")}`
}

/** Requested passes that did not run green; a pass that never reported counts as failed. */
export function failedSmokePasses(passes: readonly SmokePass[], runs: readonly SmokeRun[]): SmokePass[] {
  return passes.filter((pass) => !runs.some((run) => run.pass === pass && run.passed))
}

export function liveVerificationScript(
  artifact: string,
  origin: string,
  attempts = 12,
  delaySeconds = 10,
  aliasOrigin?: string,
): string {
  requireProbeNumber(attempts, 1, 60, "attempt count")
  requireProbeNumber(delaySeconds, 0, 60, "retry delay")
  const liveOrigin = normalizedHttpOrigin(origin, "live origin")
  const liveAlias = aliasOrigin === undefined
    ? undefined
    : normalizedHttpOrigin(aliasOrigin, "live alias")
  const program = liveVerificationProgram(
    artifact,
    liveOrigin,
    liveAlias,
    attempts,
    delaySeconds,
  )
  return `set -euo pipefail\nbun -e ${shellQuote(program)}`
}

export function indexNowProgram(timeoutMs = 20_000): string {
  requireProbeNumber(timeoutMs, 1, 20_000, "IndexNow timeout")
  return `const key = process.env.INDEXNOW_KEY ?? ""
if (!/^[0-9a-f]{32}$/.test(key)) throw new Error("IndexNow key differs")
const payload = {
  host: "almamesh.com",
  key,
  keyLocation: "https://almamesh.com/" + key + ".txt",
  urlList: [
    "https://almamesh.com/",
    "https://almamesh.com/welcome",
    "https://almamesh.com/privacy",
    "https://almamesh.com/terms",
    "https://almamesh.com/data-deletion",
  ],
}
let accepted = false
try {
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(${timeoutMs}),
  })
  accepted = response.ok
} catch {}
if (!accepted) process.exitCode = 1`
}

export function indexNowScript(artifact: string): string {
  return `set -euo pipefail
key_file=$(find ${shellQuote(artifact)} -maxdepth 1 -type f -name '????????????????????????????????.txt' -print -quit)
key="$(basename "\${key_file:-}" .txt)"
if printf '%s' "$key" | grep -Eq '^[0-9a-f]{32}$'; then
  INDEXNOW_KEY="$key" bun -e ${shellQuote(indexNowProgram())} >/dev/null || echo "IndexNow notification failed (non-fatal)" >&2
fi`
}

function liveVerificationProgram(
  artifact: string,
  origin: string,
  aliasOrigin: string | undefined,
  attempts: number,
  delaySeconds: number,
): string {
  return `const { readFileSync } = require("node:fs")
const artifact = ${JSON.stringify(artifact)}
const origin = ${JSON.stringify(origin)}
const aliasOrigin = ${JSON.stringify(aliasOrigin ?? "")}
const attempts = ${attempts}
const delayMs = ${delaySeconds * 1_000}
const expectedSha = process.env.EXPECTED_SHA ?? ""
const expected = JSON.parse(readFileSync(artifact + "/bundle/latest", "utf8"))
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("expected live SHA differs")
if (!/^[0-9a-f]{64}$/.test(expected.manifest_hash) || !Number.isSafeInteger(expected.sequence) || expected.sequence <= 0) throw new Error("expected bundle identity differs")
const expectedBundle = expected.manifest_hash + ":" + expected.sequence
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const requestUrl = (base, path) => {
  const url = new URL(path, base)
  url.searchParams.set("t", String(Date.now()))
  return url
}
const request = async (url, redirect, init = {}) => {
  const response = await fetch(url, { ...init, redirect, signal: AbortSignal.timeout(20_000) })
  const allowed = new Set([origin, aliasOrigin].filter(Boolean))
  if (!allowed.has(new URL(response.url).origin)) throw new Error("live response origin differs")
  return response
}
const responseJson = async (response) => {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > 65_536) throw new Error("live response exceeds bound")
  return JSON.parse(text)
}
const requestJson = async (url, redirect, init = {}) => {
  const response = await request(url, redirect, init)
  return { response, body: await responseJson(response) }
}
const identity = async (base, redirect) => {
  const [build, bundle] = await Promise.all([
    requestJson(requestUrl(base, "/build.json"), redirect),
    requestJson(requestUrl(base, "/bundle/latest"), redirect),
  ])
  const actualBundle = bundle.body.manifest_hash + ":" + bundle.body.sequence
  if (build.response.status !== 200 || build.body.commit !== expectedSha) throw new Error("live app identity differs")
  if (bundle.response.status !== 200 || actualBundle !== expectedBundle) throw new Error("live bundle identity differs")
}
const aliasResource = async (path) => {
  const requested = requestUrl(aliasOrigin, path)
  const response = await request(requested, "manual")
  if (response.status === 200) {
    return { response, body: await responseJson(response) }
  }
  if (response.status !== 308) throw new Error("live alias redirect status differs")
  const location = response.headers.get("location")
  if (!location) throw new Error("live alias redirect location differs")
  const target = new URL(location, requested)
  const exactTarget = target.origin === origin
    && target.pathname === requested.pathname
    && target.search === requested.search
    && target.hash === ""
  if (!exactTarget) throw new Error("live alias redirect location differs")
  return requestJson(target, "error")
}
const aliasIdentity = async () => {
  const [build, bundle] = await Promise.all([
    aliasResource("/build.json"),
    aliasResource("/bundle/latest"),
  ])
  const actualBundle = bundle.body.manifest_hash + ":" + bundle.body.sequence
  if (build.response.status !== 200 || build.body.commit !== expectedSha) throw new Error("live alias app identity differs")
  if (bundle.response.status !== 200 || actualBundle !== expectedBundle) throw new Error("live alias bundle identity differs")
}
let verified = false
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await identity(origin, "error")
    if (aliasOrigin) await aliasIdentity()
    verified = true
    break
  } catch {
    console.log("Waiting for live identity attempt=" + attempt + " expected_sha=" + expectedSha + " expected_bundle=" + expectedBundle)
    if (attempt < attempts) await pause(delayMs)
  }
}
if (!verified) throw new Error(aliasOrigin ? "live app, bundle, or alias identity did not converge" : "live application or bundle identity did not converge")
const feedback = await requestJson(requestUrl(origin, "/api/feedback"), "error", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
})
if (feedback.response.status !== 400) throw new Error("feedback route did not reject the non-writing probe")
const feedbackKeys = Object.keys(feedback.body).sort().join(",")
if (feedbackKeys !== "error,ok" || feedback.body.ok !== false || feedback.body.error !== "invalid_page") throw new Error("feedback route rejection body differed")
console.log("Live app, bundle, and feedback route identity verified: " + expectedSha + " " + expectedBundle)`
}

function providerRequest(
  evidence: GreenMainEvidence,
  identities: ReleaseIdentities,
): ProviderRequest {
  return {
    workflowRunId: evidence.workflowRunId,
    runAttempt: evidence.runAttempt,
    repository: PAGES_TARGET.repository,
    project: PAGES_TARGET.project,
    productionBranch: PAGES_TARGET.productionBranch,
    liveDomain: PAGES_TARGET.liveDomain,
    deployRoot: PAGES_TARGET.deployRoot,
    domains: [...PAGES_TARGET.domains],
    consumerIdentity: identities.consumer,
    producingIdentity: identities.producer,
    allowedRoots: [...PAGES_TARGET.allowedRoots],
    pagesFunctions: PAGES_TARGET.pagesFunctions,
  }
}

function parseObject(serialization: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(serialization)
  } catch {
    throw new Error("Foundation evidence serialization is invalid")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Foundation evidence schema differs")
  }
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Foundation evidence schema differs")
  }
  return candidate
}

function requireSource(
  repository: string,
  branch: string,
  commitSha: string,
  expectedSha: string,
): void {
  requireFullSha(commitSha, "Foundation commit SHA")
  if (repository !== PAGES_TARGET.repository || branch !== PAGES_TARGET.productionBranch) {
    throw new Error("Foundation source identity differs")
  }
  if (commitSha !== expectedSha) throw new Error("Foundation commit identity differs")
}

function requireFullSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be 40 lowercase hex characters`)
}

function requireAttempt(workflowRunId: string, runAttempt: unknown, label: string): void {
  if (!POSITIVE_INTEGER.test(workflowRunId)) {
    throw new Error(`${label} workflow run identity differs`)
  }
  if (typeof runAttempt !== "number" || !Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
    throw new Error(`${label} workflow attempt identity differs`)
  }
}

function requireProbeNumber(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} differs`)
  }
}

function normalizedHttpOrigin(value: string, label: string): string {
  const url = new URL(value)
  const valid = (["http:", "https:"] as string[]).includes(url.protocol)
    && url.username === ""
    && url.password === ""
  if (!valid) throw new Error(`${label} scheme or credentials differ`)
  return url.origin
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function validDeploymentUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:"
      && url.hostname.endsWith(`.${PAGES_TARGET.project}.pages.dev`)
      && url.username === ""
      && url.password === ""
  } catch {
    return false
  }
}
