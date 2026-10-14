import { requireAllowedRepository } from "./repositoryIdentity.js"

/**
 * The macOS WebKit lane reports crashes; it never blocks a deploy. Each lane
 * job prints its crash signatures (frontend/apps/web/scripts/crashReportSummary.mjs
 * --signatures: thread + signal + top named frame), and on a main push this
 * files one GitHub issue per signature, labelled webkit-crash, or comments on
 * the existing one with the run URL and date. Nothing here retries anything.
 */
export const CRASH_LABEL = "webkit-crash"
const TITLE_PREFIX = "WebKit crash: "
const LANES = new Set(["memory", "travel", "portable"])
const MAX_SIGNATURES = 20
const MAX_FRAMES = 12
const MAX_TEXT = 300
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** A crash reporter key is 40 hex characters; no frame symbol is. */
const REPORTER_KEY = /\b[0-9a-f]{40}\b/gi

export interface CrashSignature {
  readonly key: string
  readonly lanes: readonly string[]
  readonly process: string
  readonly exception: string
  readonly frames: readonly string[]
}

export interface CrashIssue {
  readonly number: number
  readonly title: string
  readonly state: string
}

export interface IssuesPort {
  list(): Promise<CrashIssue[]>
  create(title: string, body: string): Promise<number>
  comment(number: number, body: string): Promise<void>
  reopen(number: number): Promise<void>
}

export interface RunReference {
  readonly runUrl: string
  readonly date: string
}

/** Defense in depth: the lane already redacts, and an issue is public. */
function redact(text: string): string {
  return text.replace(UUID, "<redacted-uuid>").replace(REPORTER_KEY, "<redacted>")
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) throw new Error("crash signatures differ")
  return redact(value)
}

function signatureOf(value: unknown): CrashSignature {
  const record = (value ?? {}) as Record<string, unknown>
  const frames = record.frames
  if (typeof value !== "object" || !LANES.has(record.lane as string)
    || !Array.isArray(frames) || frames.length > MAX_FRAMES) throw new Error("crash signatures differ")
  return {
    key: text(record.key),
    lanes: [record.lane as string],
    process: text(record.process),
    exception: text(record.exception),
    frames: frames.map(text),
  }
}

/** Parse `toJSON(needs.*.outputs.crashes)`; anything else fails closed. Merges a key seen in several lanes. */
export function parseCrashOutputs(raw: string): CrashSignature[] {
  let outputs: unknown
  try { outputs = JSON.parse(raw) } catch { throw new Error("crash signatures differ") }
  if (!Array.isArray(outputs)) throw new Error("crash signatures differ")
  const byKey = new Map<string, CrashSignature>()
  for (const output of outputs) {
    if (output === "" || output === null) continue
    let lane: unknown
    try { lane = JSON.parse(String(output)) } catch { throw new Error("crash signatures differ") }
    if (!Array.isArray(lane)) throw new Error("crash signatures differ")
    for (const signature of lane.map(signatureOf)) {
      const seen = byKey.get(signature.key)
      byKey.set(signature.key, seen ? { ...seen, lanes: [...seen.lanes, ...signature.lanes] } : signature)
    }
  }
  if (byKey.size > MAX_SIGNATURES) throw new Error("crash signatures differ")
  return [...byKey.values()]
}

function evidence(signature: CrashSignature): string {
  return signature.lanes.map((lane) => `\`webkit-lane-${lane}-evidence\``).join(", ")
}

function issueBody(signature: CrashSignature, run: RunReference): string {
  return [
    "WebKit's WebContent process crashed on the macOS WebKit lane. That lane reports; it does not block deploys.",
    "",
    `Signature: \`${signature.key}\``,
    `Process: ${signature.process}`,
    `Exception: ${signature.exception}`,
    "",
    "Crashing thread, top named frames:",
    "```",
    ...signature.frames,
    "```",
    "",
    `First seen: ${run.runUrl} (${run.date}).`,
    `Redacted .ips: the run's ${evidence(signature)} artifact, under crash-reports/.`,
  ].join("\n")
}

function repeatBody(signature: CrashSignature, run: RunReference): string {
  return `Seen again: ${run.runUrl} (${run.date}). Redacted .ips: ${evidence(signature)}, under crash-reports/.`
}

/** Create an issue for each new signature; comment on (and reopen) the existing one otherwise. */
export async function fileCrashIssues(port: IssuesPort, signatures: CrashSignature[], run: RunReference): Promise<string[]> {
  if (signatures.length === 0) return ["no WebKit crash in this run"]
  const existing = await port.list()
  const lines: string[] = []
  for (const signature of signatures) {
    const title = `${TITLE_PREFIX}${signature.key}`
    const issue = existing.find((candidate) => candidate.title === title)
    if (issue === undefined) {
      lines.push(`created #${await port.create(title, issueBody(signature, run))}: ${signature.key}`)
      continue
    }
    if (issue.state === "closed") await port.reopen(issue.number)
    await port.comment(issue.number, repeatBody(signature, run))
    lines.push(`commented on #${issue.number}: ${signature.key}`)
  }
  return lines
}

/** The REST calls behind IssuesPort. Errors carry the status only, never a response body. */
export function githubIssuesPort(
  repository: string,
  readToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): IssuesPort {
  const api = `https://api.github.com/repos/${requireAllowedRepository(repository)}/issues`
  const call = async (url: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await fetcher(url, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${await readToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "almamesh-webkit-crash-issues",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub issues request failed: ${response.status}`)
    return response.json()
  }
  return {
    async list() {
      const issues: CrashIssue[] = []
      for (let page = 1; page <= 10; page += 1) {
        const batch = await call(`${api}?labels=${CRASH_LABEL}&state=all&per_page=100&page=${page}`) as Array<CrashIssue & { pull_request?: unknown }>
        issues.push(...batch.filter((item) => item.pull_request === undefined)
          .map(({ number, title, state }) => ({ number, title, state })))
        if (batch.length < 100) break
      }
      return issues
    },
    async create(title, body) {
      return (await call(api, "POST", { title, body, labels: [CRASH_LABEL] }) as { number: number }).number
    },
    async comment(number, body) { await call(`${api}/${number}/comments`, "POST", { body }) },
    async reopen(number) { await call(`${api}/${number}`, "PATCH", { state: "open" }) },
  }
}
