/** Validate same-host original-release samples before they become an RSS cap. */
import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { arch, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REFERENCE_RELEASE_COMMIT = '8d10fbbb76336a8a5efe272912e392e260b3fef5';
const SHA = /^[0-9a-f]{40}$/;
const PROJECT = 'iphone-15-webkit';

function requireValue(condition, message) {
  if (!condition) throw new Error(`WebKit baseline rejected: ${message}`);
}

export function parseLocalBaselineMiB(value) {
  const baseline = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  requireValue(Number.isFinite(baseline) && baseline > 0, 'baseline must be finite and positive');
  return baseline;
}

function collectTests(suites, tests) {
  requireValue(Array.isArray(suites), 'missing suites');
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      requireValue(Array.isArray(spec.tests), 'missing test results');
      tests.push(...spec.tests);
    }
    if (suite.suites !== undefined) collectTests(suite.suites, tests);
  }
}

export function summarizeWebKitBaseline(report, { measurementCommit }) {
  requireValue(SHA.test(measurementCommit) && measurementCommit !== REFERENCE_RELEASE_COMMIT, 'measurement commit must identify a candidate distinct from the original release');
  requireValue(Array.isArray(report.errors) && report.errors.length === 0, 'runner errors');
  requireValue(typeof report.config?.version === 'string' && report.config.version.length > 0, 'missing Playwright version');
  const tests = [];
  collectTests(report.suites, tests);
  requireValue(tests.length === 5, 'exactly five original-release boots are required');
  const samples = [];
  const repeats = new Set();
  let buildVersion;
  for (const test of tests) {
    requireValue(test.projectName === PROJECT, 'wrong device project');
    requireValue(test.expectedStatus === 'passed' && test.status === 'expected', 'runner classified boot as unexpected');
    requireValue(Array.isArray(test.results) && test.results.length === 1, 'missing or retried result');
    const result = test.results[0];
    requireValue(result.status === 'passed' && result.retry === 0, 'boot did not pass without retry');
    const attachments = (result.attachments ?? []).filter((attachment) => attachment.name === 'time-travel-memory.json');
    requireValue(attachments.length === 1 && attachments[0].contentType === 'application/json', 'missing or duplicate measurement');
    requireValue(typeof attachments[0].body === 'string', 'measurement must be an inline JSON attachment');
    const sample = JSON.parse(Buffer.from(attachments[0].body, 'base64').toString('utf8'));
    // Playwright's JSON reporter omits TestCase.repeatEachIndex; the harness
    // records TestInfo.repeatEachIndex in its inline measurement attachment.
    requireValue(Number.isInteger(sample.repeatEachIndex) && sample.repeatEachIndex >= 0 && sample.repeatEachIndex < 5, 'invalid repeat index');
    requireValue(!repeats.has(sample.repeatEachIndex), 'duplicate repeat index');
    repeats.add(sample.repeatEachIndex);
    requireValue(sample.kind === 'boot-baseline' && sample.lane === PROJECT && sample.completed === true, 'incomplete original boot');
    requireValue(typeof sample.peakSingleWebMiB === 'number' && Number.isFinite(sample.peakSingleWebMiB) && sample.peakSingleWebMiB > 0, 'invalid RSS sample');
    const reference = sample.reference;
    requireValue(reference?.expectedCommit === REFERENCE_RELEASE_COMMIT && reference.servedCommit === REFERENCE_RELEASE_COMMIT, 'served source is not the pinned original release');
    requireValue(reference.measurementCommit === measurementCommit, 'sampler source does not match this candidate');
    requireValue(reference.platform === 'darwin', 'measurement did not run on macOS');
    requireValue(typeof reference.buildVersion === 'string' && reference.buildVersion.length > 0, 'missing reference build identity');
    buildVersion ??= reference.buildVersion;
    requireValue(reference.buildVersion === buildVersion, 'reference build changed between samples');
    samples.push({ repeatEachIndex: sample.repeatEachIndex, rssMiB: sample.peakSingleWebMiB });
  }
  samples.sort((a, b) => a.repeatEachIndex - b.repeatEachIndex);
  const samplesMiB = samples.map((sample) => sample.rssMiB);
  return {
    schemaVersion: 1, source: 'same-host-original-release',
    referenceCommit: REFERENCE_RELEASE_COMMIT, measurementCommit,
    playwrightVersion: report.config.version, referenceBuildVersion: buildVersion,
    sampleCount: 5, samplesMiB, baselineMiB: Math.max(...samplesMiB),
  };
}

function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    requireValue(['--report', '--local-baseline', '--provenance', '--measurement-commit'].includes(key) && value !== undefined && !options.has(key), 'invalid CLI arguments');
    options.set(key, value);
  }
  const measurementCommit = options.get('--measurement-commit');
  requireValue(SHA.test(measurementCommit ?? '') && measurementCommit !== REFERENCE_RELEASE_COMMIT, 'measurement commit must identify a candidate distinct from the original release');
  requireValue(options.has('--provenance') && options.has('--report') !== options.has('--local-baseline'), 'supply one measured baseline source and provenance path');
  let evidence;
  if (options.has('--report')) {
    evidence = summarizeWebKitBaseline(JSON.parse(readFileSync(options.get('--report'), 'utf8')), { measurementCommit });
  } else {
    requireValue(!process.env.CI, 'hosted CI cannot use an unproven local scalar');
    evidence = {
      schemaVersion: 1, source: 'explicit-local-measurement',
      referenceCommit: REFERENCE_RELEASE_COMMIT, measurementCommit,
      baselineMiB: parseLocalBaselineMiB(options.get('--local-baseline')),
      note: 'Caller-supplied prior local measurement; not hosted baseline evidence.',
    };
  }
  evidence.machine = { platform: platform(), release: release(), arch: arch(), memoryBytes: totalmem() };
  writeFileSync(options.get('--provenance'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${evidence.baselineMiB}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2));
}
