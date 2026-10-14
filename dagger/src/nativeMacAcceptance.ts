import { requireAllowedRepository } from "./repositoryIdentity.js"

/**
 * Real Safari (.github/workflows/safari-smoke.yml) must be green for the SHA
 * before production changes. The macOS WebKit lane is not read here: it
 * reports crashes as issues and gates nothing.
 * Run in a fresh, uncached Node container before any deployment side effect.
 */
export function nativeMacAcceptanceScript(repository: string, commitSha: string): string {
  const allowedRepository = requireAllowedRepository(repository)
  if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("Native macOS acceptance commit is invalid.")
  }
  return String.raw`
let nativeMacFailure = "unavailable";
(async () => {
  const repository = ${JSON.stringify(allowedRepository)};
  const commitSha = ${JSON.stringify(commitSha)};
  const workflow = ".github/workflows/safari-smoke.yml";
  const workflowFile = "safari-smoke.yml";
  const workflowName = "Safari (macOS)";
  const api = "https://api.github.com/repos/" + repository;
  const html = "https://github.com/" + repository;
  const jobNames = ["safari / macOS smoke"];
  const pending = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
  const started = performance.now();
  const deadlineMs = 45 * 60 * 1000;
  const pollMs = 15 * 1000;
  const deny = code => { nativeMacFailure = code; throw new Error("Native macOS acceptance denied."); };
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const integer = value => Number.isSafeInteger(value) && value > 0;
  const noPullRequests = value => Array.isArray(value) && value.length === 0;
  const remaining = () => deadlineMs - (performance.now() - started);
  const checkDeadline = () => { if (remaining() <= 0) deny("deadline"); };
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim() === "") deny("authentication");
  const get = async path => {
    checkDeadline();
    let response;
    try {
      response = await fetch(api + path, {
        method: "GET", cache: "no-store", redirect: "error",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          "Cache-Control": "no-cache", "User-Agent": "almamesh-native-macos-acceptance"
        },
        signal: AbortSignal.timeout(Math.max(1, Math.min(30000, Math.floor(remaining()))))
      });
    } catch { deny("api"); }
    checkDeadline();
    if (!response || !response.ok) deny("api");
    let value;
    try { value = await response.json(); } catch { deny("api"); }
    checkDeadline();
    return value;
  };
  const successfulOrPending = value => {
    if (value.status === "completed") {
      if (value.conclusion !== "success") deny("unsuccessful");
      return true;
    }
    if (!pending.has(value.status) || value.conclusion !== null) deny("identity");
    return false;
  };
  const workflowValue = await get("/actions/workflows/" + workflowFile);
  if (!object(workflowValue) || !integer(workflowValue.id) || workflowValue.name !== workflowName
    || workflowValue.path !== workflow || workflowValue.state !== "active") deny("identity");
  const validateRun = value => {
    if (!object(value) || !integer(value.id) || !integer(value.run_attempt) || !integer(value.check_suite_id)
      || value.workflow_id !== workflowValue.id || value.name !== workflowName || value.path !== workflow
      || value.head_sha !== commitSha || value.head_branch !== "main" || value.event !== "push"
      || !noPullRequests(value.pull_requests) || value.repository?.full_name !== repository
      || value.head_repository?.full_name !== repository
      || value.url !== api + "/actions/runs/" + value.id
      || value.jobs_url !== api + "/actions/runs/" + value.id + "/jobs"
      || value.check_suite_url !== api + "/check-suites/" + value.check_suite_id
      || value.workflow_url !== api + "/actions/workflows/" + workflowValue.id
      || value.html_url !== html + "/actions/runs/" + value.id) deny("identity");
    return value;
  };
  const latest = async () => {
    const value = await get("/actions/workflows/" + workflowFile + "/runs?branch=main&event=push&head_sha="
      + commitSha + "&per_page=100&page=1");
    if (!object(value) || !Number.isSafeInteger(value.total_count) || value.total_count < 0
      || !Array.isArray(value.workflow_runs) || value.total_count !== value.workflow_runs.length
      || value.total_count > 100) deny("identity");
    const ids = new Set();
    for (const run of value.workflow_runs) {
      validateRun(run);
      if (ids.has(run.id)) deny("identity");
      ids.add(run.id);
    }
    return value.workflow_runs.reduce((newest, run) => !newest || run.id > newest.id ? run : newest, null);
  };
  const sameAttempt = (left, right) => left.id === right.id && left.run_attempt === right.run_attempt
    && left.check_suite_id === right.check_suite_id;
  const pause = async () => {
    checkDeadline();
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining())));
    checkDeadline();
  };
  for (;;) {
    checkDeadline();
    const listed = await latest();
    if (!listed) { await pause(); continue; }
    successfulOrPending(listed);
    const run = validateRun(await get("/actions/runs/" + listed.id));
    const runComplete = successfulOrPending(run);
    if (!sameAttempt(listed, run)) { await pause(); continue; }
    const suite = await get("/check-suites/" + run.check_suite_id);
    if (!object(suite) || suite.id !== run.check_suite_id || suite.app?.id !== 15368
      || suite.head_sha !== commitSha || suite.head_branch !== "main"
      || suite.repository?.full_name !== repository || !noPullRequests(suite.pull_requests)) deny("identity");
    const suiteComplete = successfulOrPending(suite);
    const value = await get("/actions/runs/" + run.id + "/attempts/" + run.run_attempt + "/jobs?per_page=100&page=1");
    if (!object(value) || !Number.isSafeInteger(value.total_count) || value.total_count < 0
      || !Array.isArray(value.jobs) || value.total_count !== value.jobs.length
      || value.jobs.length > jobNames.length) deny("identity");
    const jobs = new Map();
    const ids = new Set();
    let jobsComplete = true;
    for (const job of value.jobs) {
      if (!object(job) || !integer(job.id) || !jobNames.includes(job.name) || jobs.has(job.name) || ids.has(job.id)
        || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.workflow_name !== workflowName
        || job.head_sha !== commitSha || job.head_branch !== "main"
        || job.run_url !== api + "/actions/runs/" + run.id
        || job.url !== api + "/actions/jobs/" + job.id
        || job.check_run_url !== api + "/check-runs/" + job.id
        || job.html_url !== html + "/actions/runs/" + run.id + "/job/" + job.id) deny("identity");
      jobs.set(job.name, job);
      ids.add(job.id);
      if (!successfulOrPending(job)) jobsComplete = false;
    }
    if (runComplete && jobs.size !== jobNames.length) deny("missing-jobs");
    if (!runComplete || !suiteComplete || !jobsComplete || jobs.size !== jobNames.length) { await pause(); continue; }
    let checksComplete = true;
    for (const name of jobNames) {
      const job = jobs.get(name);
      const check = await get("/check-runs/" + job.id);
      if (!object(check) || check.id !== job.id || check.name !== name || check.app?.id !== 15368
        || check.head_sha !== commitSha || check.check_suite?.id !== run.check_suite_id
        || check.details_url !== job.html_url) deny("identity");
      if (!successfulOrPending(check)) checksComplete = false;
    }
    if (!checksComplete) { await pause(); continue; }
    const fresh = await latest();
    if (!fresh) deny("identity");
    const freshComplete = successfulOrPending(fresh);
    if (!sameAttempt(run, fresh) || !freshComplete) { await pause(); continue; }
    const finalRun = validateRun(await get("/actions/runs/" + fresh.id));
    const finalComplete = successfulOrPending(finalRun);
    if (!sameAttempt(run, finalRun) || !finalComplete) { await pause(); continue; }
    checkDeadline();
    console.log(JSON.stringify({
      schemaVersion: 1, repository, commitSha, workflow,
      runId: run.id, runAttempt: run.run_attempt, checkSuiteId: run.check_suite_id, status: "success"
    }));
    return;
  }
})().catch(() => {
  // Never print an API response, exception, URL, token or arbitrary error text.
  console.error("Native macOS acceptance failed: " + nativeMacFailure + ".");
  process.exitCode = 1;
});
`
}
