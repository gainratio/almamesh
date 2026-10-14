import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { nativeMacAcceptanceScript } from '../dagger/src/nativeMacAcceptance.ts';

const repository = 'gainratio/almamesh';
const commitSha = 'd'.repeat(40);
// Real Safari gates production; the macOS WebKit lane only files crash issues.
const workflow = '.github/workflows/safari-smoke.yml';
const api = `https://api.github.com/repos/${repository}`;
const token = 'PRIVATE-GITHUB-TOKEN-never-print';
const names = ['safari / macOS smoke'];

function runFixture(overrides: Record<string, unknown> = {}) {
  const id = overrides.id ?? 100;
  const suiteId = overrides.check_suite_id ?? 30;
  const workflowId = overrides.workflow_id ?? 20;
  return {
    id: 100, workflow_id: 20, check_suite_id: 30, run_attempt: 1,
    name: 'Safari (macOS)', path: workflow, head_branch: 'main', head_sha: commitSha,
    event: 'push', status: 'completed', conclusion: 'success', pull_requests: [],
    repository: { full_name: repository }, head_repository: { full_name: repository },
    url: `${api}/actions/runs/${id}`, jobs_url: `${api}/actions/runs/${id}/jobs`,
    check_suite_url: `${api}/check-suites/${suiteId}`, workflow_url: `${api}/actions/workflows/${workflowId}`,
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    ...overrides,
  };
}

function jobFixture(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 40 + index, run_id: 100, run_attempt: 1, workflow_name: 'Safari (macOS)',
    head_branch: 'main', head_sha: commitSha, name: names[index],
    status: 'completed', conclusion: 'success',
    run_url: `${api}/actions/runs/100`, url: `${api}/actions/jobs/${40 + index}`,
    check_run_url: `${api}/check-runs/${40 + index}`,
    html_url: `https://github.com/${repository}/actions/runs/100/job/${40 + index}`,
    ...overrides,
  };
}

function suiteFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 30, head_sha: commitSha, head_branch: 'main', pull_requests: [],
    repository: { full_name: repository }, app: { id: 15368 },
    status: 'completed', conclusion: 'success', ...overrides,
  };
}

function checkFixture(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 40 + index, name: names[index], head_sha: commitSha,
    app: { id: 15368 }, check_suite: { id: 30 },
    status: 'completed', conclusion: 'success',
    details_url: `https://github.com/${repository}/actions/runs/100/job/${40 + index}`,
    ...overrides,
  };
}

interface ResponseFixture {
  path: string;
  body?: unknown;
  status?: number;
  throws?: string;
  elapsedMs?: number;
}

const workflowResponse = (): ResponseFixture => ({
  path: '/actions/workflows/safari-smoke.yml',
  body: { id: 20, name: 'Safari (macOS)', path: workflow, state: 'active' },
});
const listingResponse = (runs = [runFixture()]): ResponseFixture => ({
  path: `/actions/workflows/safari-smoke.yml/runs?branch=main&event=push&head_sha=${commitSha}&per_page=100&page=1`,
  body: { total_count: runs.length, workflow_runs: runs },
});
const detailResponse = (run = runFixture()): ResponseFixture => ({ path: '/actions/runs/100', body: run });
const suiteResponse = (suite = suiteFixture()): ResponseFixture => ({ path: '/check-suites/30', body: suite });
const jobsResponse = (jobs = names.map((_, i) => jobFixture(i))): ResponseFixture => ({
  path: '/actions/runs/100/attempts/1/jobs?per_page=100&page=1',
  body: { total_count: jobs.length, jobs },
});
const checkResponses = () => names.map((_, i): ResponseFixture => ({ path: `/check-runs/${40 + i}`, body: checkFixture(i) }));
const FINAL_LISTING = 5 + names.length;
const FINAL_DETAIL = FINAL_LISTING + 1;
const successfulResponses = (): ResponseFixture[] => [
  workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(),
  ...checkResponses(), listingResponse(), detailResponse(),
];

function execute(responses: ResponseFixture[], options: { token?: string; startedMs?: number } = {}) {
  const script = nativeMacAcceptanceScript(repository, commitSha);
  const harness = `
const fixtures = ${JSON.stringify(responses)};
const requests = [];
const sleeps = [];
let clock = ${options.startedMs ?? 0};
Object.defineProperty(globalThis, "performance", { value: { now: () => clock } });
globalThis.setTimeout = (callback, ms) => { sleeps.push(ms); clock += ms; queueMicrotask(callback); return 0; };
globalThis.fetch = async (url, options) => {
  const fixture = fixtures.shift();
  const path = String(url).replace(${JSON.stringify(api)}, "");
  requests.push({ path, method: options.method, cache: options.cache,
    noCache: options.headers["Cache-Control"], authorized: options.headers.Authorization === ${JSON.stringify(`Bearer ${token}`)},
    hasSignal: Boolean(options.signal), redirect: options.redirect });
  if (!fixture || fixture.path !== path) throw new Error("PRIVATE unexpected API response " + path);
  clock += fixture.elapsedMs || 0;
  if (fixture.throws) throw new Error(fixture.throws);
  const status = fixture.status ?? 200;
  return { ok: status >= 200 && status < 300, status,
    json: async () => fixture.body, text: async () => "PRIVATE API body" };
};
process.on("beforeExit", () => console.log("TEST_OBSERVATION=" + JSON.stringify({ requests, sleeps, remaining: fixtures.length })));
${script}
`;
  const child = spawnSync('node', ['--eval', harness], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: options.token ?? token }, timeout: 10_000,
  });
  const lines = child.stdout.trim().split('\n');
  const observationLine = lines.find(line => line.startsWith('TEST_OBSERVATION='));
  const observation = observationLine ? JSON.parse(observationLine.slice('TEST_OBSERVATION='.length)) : undefined;
  const receiptLine = lines.find(line => line.startsWith('{'));
  return { ...child, observation, receipt: receiptLine ? JSON.parse(receiptLine) : undefined };
}

function expectDenied(result: ReturnType<typeof execute>) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.receipt).toBeUndefined();
  expect(result.stderr).toMatch(/^Native macOS acceptance failed: [a-z-]+\.\n$/);
  expect(result.stdout + result.stderr).not.toContain(token);
  expect(result.stdout + result.stderr).not.toContain('PRIVATE API');
  expect(result.stdout + result.stderr).not.toContain('PRIVATE unexpected');
}

describe('native macOS deployment acceptance', () => {
  test('accepts only the exact successful main attempt after checking all jobs, app identity and a fresh final run', () => {
    const result = execute(successfulResponses());
    expect(result.status, result.stderr).toBe(0);
    expect(result.receipt).toEqual({ schemaVersion: 1, repository, commitSha, workflow, runId: 100, runAttempt: 1, checkSuiteId: 30, status: 'success' });
    expect(result.observation.requests).toHaveLength(7 + names.length);
    expect(result.observation.remaining).toBe(0);
    for (const request of result.observation.requests) expect(request).toMatchObject({ method: 'GET', cache: 'no-store', noCache: 'no-cache', authorized: true, hasSignal: true, redirect: 'error' });
  });

  test('validates factory arguments before interpolating them into a program', () => {
    for (const repo of ['attacker/almamesh', 'gainratio/almamesh\nPRIVATE', '', 'https://github.com/gainratio/almamesh']) expect(() => nativeMacAcceptanceScript(repo, commitSha)).toThrow();
    for (const sha of ['', 'D'.repeat(40), 'd'.repeat(39), 'd'.repeat(40) + ';PRIVATE']) expect(() => nativeMacAcceptanceScript(repository, sha)).toThrow();
    expect(nativeMacAcceptanceScript('hseshadr/almamesh', commitSha)).toContain('hseshadr/almamesh');
  });

  test('denies missing authentication without printing the token or requesting GitHub', () => {
    const result = execute(successfulResponses(), { token: '' });
    expectDenied(result);
    expect(result.observation.requests).toHaveLength(0);
  });

  test('the latest failed run wins over an older successful run', () => {
    expectDenied(execute([workflowResponse(), listingResponse([runFixture({ id: 99 }), runFixture({ status: 'completed', conclusion: 'failure' })])]));
  });

  test('a superseded failed run does not replace the latest fully checked successful run', () => {
    const responses = successfulResponses();
    const runs = [runFixture({ id: 99, conclusion: 'failure' }), runFixture()];
    responses[1] = listingResponse(runs);
    responses[FINAL_LISTING] = listingResponse(runs);
    const result = execute(responses);
    expect(result.status, result.stderr).toBe(0);
    expect(result.receipt.runId).toBe(100);
  });

  for (const [field, value] of [
    ['head_sha', 'a'.repeat(40)], ['head_branch', 'feature'], ['event', 'pull_request'],
    ['path', '.github/workflows/other.yml'], ['workflow_id', 21], ['name', 'Other workflow'],
    ['repository', { full_name: 'attacker/almamesh' }], ['head_repository', { full_name: 'attacker/almamesh' }],
    ['pull_requests', [{ number: 1 }]], ['run_attempt', 0], ['check_suite_id', 0],
  ] as const) {
    test(`denies a run with mismatched ${field}`, () => {
      expectDenied(execute([workflowResponse(), listingResponse([runFixture({ [field]: value })])]));
    });
  }

  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', null]) {
    test(`denies a completed run with ${conclusion} conclusion`, () => {
      expectDenied(execute([workflowResponse(), listingResponse([runFixture({ conclusion })])]));
    });
  }

  test('denies an ambiguous duplicated run and an incomplete paginated listing', () => {
    expectDenied(execute([workflowResponse(), listingResponse([runFixture(), runFixture()])]));
    const listing = listingResponse(); listing.body = { total_count: 101, workflow_runs: [runFixture()] };
    expectDenied(execute([workflowResponse(), listing]));
  });

  test('waits for a missing queued workflow and queued jobs, then accepts their completed attempt', () => {
    const queued = runFixture({ status: 'queued', conclusion: null });
    const pendingSuite = suiteFixture({ status: 'queued', conclusion: null });
    const result = execute([
      workflowResponse(), listingResponse([]),
      listingResponse([queued]), detailResponse(queued), suiteResponse(pendingSuite), jobsResponse([]),
      ...successfulResponses().slice(1),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.observation.sleeps).toEqual([15_000, 15_000]);
  });

  test('fails closed if a completed run is missing a required job or repeats its name', () => {
    for (const jobs of [[], [jobFixture(0), jobFixture(0, { id: 45 })]]) {
      expectDenied(execute([workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(jobs)]));
    }
  });

  for (const overrides of [
    { run_attempt: 2 }, { run_id: 101 }, { head_sha: 'a'.repeat(40) },
    { head_branch: 'feature' }, { workflow_name: 'Other workflow' },
    { check_run_url: 'https://attacker.example/PRIVATE' },
    { status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'skipped' },
  ]) {
    test(`denies a mismatched or unsuccessful job ${JSON.stringify(overrides)}`, () => {
      const jobs = names.map((_, i) => jobFixture(i, overrides));
      expectDenied(execute([workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(jobs)]));
    });
  }

  test('denies a successful check from the wrong app, suite, SHA, name or workflow details URL', () => {
    for (const overrides of [{ app: { id: 1 } }, { check_suite: { id: 31 } }, { head_sha: 'a'.repeat(40) }, { name: 'webkit / macOS memory' }, { details_url: 'https://github.com/attacker/almamesh/actions/runs/100/job/40' }, { conclusion: 'neutral' }]) {
      const checks = checkResponses(); checks[0].body = checkFixture(0, overrides);
      expectDenied(execute([workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(), ...checks]));
    }
  });

  test('waits for a queued check-run propagation delay, then checks the successful attempt again', () => {
    const checks = checkResponses();
    checks[0].body = checkFixture(0, { status: 'queued', conclusion: null });
    const result = execute([
      workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(), ...checks,
      ...successfulResponses().slice(1),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.observation.sleeps).toEqual([15_000]);
    expect(result.observation.remaining).toBe(0);
    expect(result.receipt.runAttempt).toBe(1);
  });

  test('rejects a completed failed check-run without polling it into success', () => {
    const checks = checkResponses();
    checks[0].body = checkFixture(0, { status: 'completed', conclusion: 'failure' });
    const result = execute([
      workflowResponse(), listingResponse(), detailResponse(), suiteResponse(), jobsResponse(), ...checks,
      ...successfulResponses().slice(1),
    ]);
    expectDenied(result);
    expect(result.observation.sleeps).toEqual([]);
    expect(result.stderr).toContain('unsuccessful');
  });

  test('denies a suite from the wrong app, repository, SHA or pull request', () => {
    for (const overrides of [{ app: { id: 1 } }, { repository: { full_name: 'attacker/almamesh' } }, { head_sha: 'a'.repeat(40) }, { head_branch: 'feature' }, { pull_requests: [{ number: 1 }] }, { conclusion: 'failure' }]) {
      expectDenied(execute([workflowResponse(), listingResponse(), detailResponse(), suiteResponse(suiteFixture(overrides))]));
    }
  });

  test('does not accept a stale attempt when a rerun appears in the final check', () => {
    const responses = successfulResponses(); responses[FINAL_LISTING] = listingResponse([runFixture({ run_attempt: 2, status: 'completed', conclusion: 'failure' })]);
    expectDenied(execute(responses));
  });

  test('does not accept an old green run when a newer run appears in the final check', () => {
    const responses = successfulResponses(); responses[FINAL_LISTING] = listingResponse([runFixture(), runFixture({ id: 101, conclusion: 'failure' })]);
    expectDenied(execute(responses));
  });

  test('rechecks the run detail after the final listing, so an attempt change cannot pass', () => {
    const responses = successfulResponses(); responses[FINAL_DETAIL] = detailResponse(runFixture({ run_attempt: 2, conclusion: 'failure' }));
    expectDenied(execute(responses));
  });

  test('denies HTTP and network failures using fixed diagnostics', () => {
    for (const fixture of [{ ...workflowResponse(), status: 403, body: { message: token } }, { ...workflowResponse(), throws: token + ' PRIVATE API body' }]) expectDenied(execute([fixture]));
  });

  test('never prints arbitrary API values when a malformed response contains a secret', () => {
    const malformed = runFixture({ head_branch: token, head_repository: { full_name: token } });
    expectDenied(execute([workflowResponse(), listingResponse([malformed])]));
    const malformedWorkflow = workflowResponse();
    malformedWorkflow.body = { id: 20, name: token, path: workflow, state: 'active' };
    expectDenied(execute([malformedWorkflow]));
  });

  test('rejects an inconsistent detail response even when the listing is successful', () => {
    expectDenied(execute([workflowResponse(), listingResponse(), detailResponse(runFixture({ event: 'pull_request' }))]));
  });

  test('bounds pending acceptance at 45 minutes without extending the polling interval', () => {
    const empty = listingResponse([]);
    const result = execute([workflowResponse(), ...Array.from({ length: 180 }, () => empty)]);
    expectDenied(result);
    expect(result.stderr).toContain('deadline');
    expect(result.observation.sleeps).toHaveLength(180);
    expect(new Set(result.observation.sleeps)).toEqual(new Set([15_000]));
  });

  test('counts request time toward the same deadline and never accepts evidence after it', () => {
    const responses = successfulResponses(); responses[FINAL_DETAIL].elapsedMs = 45 * 60 * 1000;
    expectDenied(execute(responses));
  });
});
