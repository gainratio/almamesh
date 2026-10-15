import { requireAllowedRepository } from "./repositoryIdentity.js"

/**
 * Production deploy has two triggers, because it needs two green workflows for
 * the same main SHA: Dagger (the protected attempt the Foundation binds) and
 * Safari (macOS) (real Safari through safaridriver, rerun on its own when it flakes).
 * The macOS WebKit lane gates nothing: it files crash signatures as issues.
 *
 * - A Dagger completion deploys exactly that Dagger attempt (and waits for
 *   Safari, as before).
 * - A Safari completion deploys only when the newest Dagger attempt for the
 *   SHA is already green; while Dagger is still running it skips, because the
 *   Dagger completion will deploy.
 * - Either trigger skips when production already serves the SHA. Deploys are
 *   serialized by the workflow's concurrency group, so whichever trigger runs
 *   second sees the first one's release and does nothing: no double deploy.
 *
 * Stale or non-main SHAs are still refused by the Foundation's green-main
 * decision and the workflow's push/main/same-repository gate.
 */
export type DeployTrigger = "dagger" | "safari"

const TRIGGER_WORKFLOWS: Readonly<Record<string, DeployTrigger>> = Object.freeze({
  ".github/workflows/dagger.yml": "dagger",
  ".github/workflows/safari-smoke.yml": "safari",
})

export function parseDeployTrigger(workflowPath: string): DeployTrigger {
  const trigger = Object.hasOwn(TRIGGER_WORKFLOWS, workflowPath) ? TRIGGER_WORKFLOWS[workflowPath] : undefined
  if (trigger === undefined) throw new Error("Deploy trigger workflow is not allowed.")
  return trigger
}

export type DaggerAttempt =
  | { readonly state: "green"; readonly workflowRunId: string; readonly runAttempt: number }
  | { readonly state: "pending" }
  | { readonly state: "red" }

export interface BoundAttempt {
  readonly workflowRunId: string
  readonly runAttempt: number
}

export interface TriggerPort {
  /** The commit production serves now, or null when it cannot be read. */
  liveCommit(): Promise<string | null>
  /** The newest Dagger push attempt for the SHA on main. */
  daggerAttempt(): Promise<DaggerAttempt>
}

/** The Dagger attempt deliverProduction must bind, or why this trigger does nothing. */
export async function bindDeployTrigger(
  port: TriggerPort,
  trigger: DeployTrigger,
  expectedSha: string,
  triggerAttempt: BoundAttempt,
): Promise<BoundAttempt | { readonly skip: string }> {
  if (await port.liveCommit() === expectedSha) {
    return { skip: `SKIP ${expectedSha}: production already serves this commit` }
  }
  if (trigger === "dagger") return triggerAttempt
  const attempt = await port.daggerAttempt()
  if (attempt.state === "pending") {
    return { skip: `SKIP ${expectedSha}: Dagger is still running; its completion deploys this commit` }
  }
  if (attempt.state === "red") {
    return { skip: `SKIP ${expectedSha}: the newest Dagger attempt is not green; nothing to deploy` }
  }
  return { workflowRunId: attempt.workflowRunId, runAttempt: attempt.runAttempt }
}

/** Parse the lookup script's single receipt line; anything else fails closed. */
export function parseDaggerAttempt(stdout: string): DaggerAttempt {
  const value: unknown = JSON.parse(stdout.trim())
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Dagger attempt differs")
  const record = value as Record<string, unknown>
  if (record.state === "pending" || record.state === "red") return { state: record.state }
  const { runId, runAttempt } = record
  if (record.state !== "green" || !Number.isSafeInteger(runId) || (runId as number) <= 0
    || !Number.isSafeInteger(runAttempt) || (runAttempt as number) <= 0) {
    throw new Error("Dagger attempt differs")
  }
  return { state: "green", workflowRunId: String(runId), runAttempt: runAttempt as number }
}

/** Run in a fresh, uncached Node container. Prints one receipt line; never an API body. */
export function daggerAttemptScript(repository: string, commitSha: string): string {
  const allowedRepository = requireAllowedRepository(repository)
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Dagger attempt commit is invalid.")
  return String.raw`
(async () => {
  const repository = ${JSON.stringify(allowedRepository)};
  const commitSha = ${JSON.stringify(commitSha)};
  const api = "https://api.github.com/repos/" + repository;
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim() === "") throw 0;
  const response = await fetch(api + "/actions/workflows/dagger.yml/runs?branch=main&event=push&head_sha="
    + commitSha + "&per_page=100&page=1", {
    method: "GET", cache: "no-store", redirect: "error",
    headers: {
      Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache", "User-Agent": "almamesh-deploy-trigger"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw 0;
  const value = await response.json();
  if (!value || !Array.isArray(value.workflow_runs) || value.total_count !== value.workflow_runs.length
    || value.total_count > 100) throw 0;
  const positive = n => Number.isSafeInteger(n) && n > 0;
  let newest = null;
  for (const run of value.workflow_runs) {
    if (!run || !positive(run.id) || !positive(run.run_attempt) || run.name !== "Dagger"
      || run.path !== ".github/workflows/dagger.yml" || run.head_sha !== commitSha
      || run.head_branch !== "main" || run.event !== "push"
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw 0;
    if (!newest || run.id > newest.id) newest = run;
  }
  let receipt = { state: "pending" };
  if (newest && newest.status === "completed") {
    receipt = newest.conclusion === "success"
      ? { state: "green", runId: newest.id, runAttempt: newest.run_attempt }
      : { state: "red" };
  }
  console.log(JSON.stringify(receipt));
})().catch(() => {
  console.error("Dagger attempt lookup failed.");
  process.exitCode = 1;
});
`
}

/** Read the live build identity; prints {"commit": sha|null}. A failed read is null, never a skip. */
export function liveCommitScript(origin: string): string {
  return String.raw`
(async () => {
  let commit = null;
  try {
    const url = new URL("/build.json", ${JSON.stringify(origin)});
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    const type = response.headers.get("content-type") || "";
    if (response.ok && type.includes("application/json")) {
      const body = await response.json();
      if (body && typeof body.commit === "string" && /^[0-9a-f]{40}$/.test(body.commit)) commit = body.commit;
    }
  } catch {}
  console.log(JSON.stringify({ commit }));
})();
`
}

export function parseLiveCommit(stdout: string): string | null {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    const commit = (value as { commit?: unknown } | null)?.commit
    return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null
  } catch {
    return null
  }
}
