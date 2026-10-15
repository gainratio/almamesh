/**
 * Live-model specs use the cheapest shared E2E model, except the full report
 * acceptance check, which must exercise the production report-engine model.
 *
 * - The constant itself is pinned to its literal.
 * - A real spec names no model id of its own: models come from e2e/realModel.ts
 *   or the production report-model constant (env-override fallbacks included).
 *   The one literal exception is the retired slug
 *   the self-heal spec seeds on purpose; the app rewrites it before any call.
 * - `PRODUCT_DEFAULT_MODEL` (the reading default the app picks itself),
 *   `PRODUCT_CHAT_DEFAULT_MODEL` (its chat default) and any alias of either are
 *   only ever asserted or logged, never configured or passed along, and each
 *   must match the app's real default. E2E_REAL_MODEL differs from both, or a
 *   spec asserting "the app used its own default, not the seeded model" could
 *   never fail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CHAT_CLOUD_MODEL, RECOMMENDED_CLOUD_MODEL, REPORT_ENGINE_MODEL, REPORT_SECTIONS } from '@almamesh/llm';

import {
  E2E_REAL_MODEL,
  PRODUCT_CHAT_DEFAULT_MODEL,
  PRODUCT_DEFAULT_MODEL,
  REPORT_ENGINE_DEFAULT_MODEL,
} from '../../e2e/realModel';

const E2E_DIR = resolve(__dirname, '../../e2e');

/** Model ids a real spec may name itself, and why. */
const ALLOWED_LITERALS: Readonly<Record<string, readonly string[]>> = {
  // The stale model the self-heal spec seeds; never sent to the provider.
  'interpretation.heal.real.spec.ts': ['anthropic/claude-3.5-sonnet'],
};

const PROVIDER_SLUG =
  /\b(?:deepseek|anthropic|openai|google|meta-llama|mistralai|qwen|x-ai|z-ai|moonshotai|cohere|nvidia|microsoft|amazon|minimax|openrouter)\/[\w.:-]+/g;
/**
 * Names that hold the product default: PRODUCT_DEFAULT_MODEL itself plus every
 * `const X = PRODUCT_DEFAULT_MODEL` or `const X = <env> ?? PRODUCT_DEFAULT_MODEL`
 * alias (and aliases of aliases).
 */
function productDefaultAliases(code: string): ReadonlySet<string> {
  const names = new Set(['PRODUCT_DEFAULT_MODEL', 'PRODUCT_CHAT_DEFAULT_MODEL']);
  const declaration = /const\s+(\w+)\s*=\s*(?:[^;\n]*\?\?\s*)?(\w+)\s*;/g;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, alias, source] of code.matchAll(declaration)) {
      if (alias !== undefined && source !== undefined && names.has(source) && !names.has(alias)) {
        names.add(alias);
        grew = true;
      }
    }
  }
  return names;
}

/** A line where the product default may appear: it is only checked or reported there. */
function onlyAssertsOrReports(line: string, name: string, aliases: ReadonlySet<string>): boolean {
  const trimmed = line.trim();
  const declared = /^const\s+(\w+)\s*=/.exec(trimmed)?.[1];
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('import ') ||
    (declared !== undefined && aliases.has(declared)) ||
    /\bexpect\(|\.toBe\(|\.toEqual\(|console\.log\(/.test(line) ||
    interpolatedIntoText(line, name)
  );
}

/**
 * The name is interpolated into a longer string (a message, a label, a file
 * name, possibly through an expression like `.replace()`). A
 * template literal that is ONLY the name (`` `${NAME}` ``) is the value itself,
 * so it counts as a send.
 */
function interpolatedIntoText(line: string, name: string): boolean {
  const interpolated = new RegExp(`\\$\\{\\s*${name}\\b`);
  const bareTemplate = new RegExp(`\`\\$\\{\\s*${name}\\s*\\}\``);
  return interpolated.test(line) && !bareTemplate.test(line);
}

/** Lines that use the product default (or an alias) as something the test sends. */
function sendsProductDefault(code: string): string[] {
  const aliases = productDefaultAliases(code);
  return code.split('\n').filter((line) =>
    [...aliases].some(
      (name) => new RegExp(`\\b${name}\\b`).test(line) && !onlyAssertsOrReports(line, name, aliases),
    ),
  );
}

function realSpecs(): string[] {
  return readdirSync(E2E_DIR).filter((name) => name.endsWith('.real.spec.ts'));
}

function source(spec: string): string {
  return readFileSync(join(E2E_DIR, spec), 'utf8');
}

/** Evaluate only the spec's model initializer, without registering a live test. */
function configuredReportModel(env: Readonly<Record<string, string | undefined>>): unknown {
  const expression = /const MODEL = ([^;]+);/.exec(source('report.real.spec.ts'))?.[1];
  if (expression === undefined) throw new Error('report MODEL initializer missing');
  return runInNewContext(expression, { process: { env }, E2E_REAL_MODEL, REPORT_ENGINE_MODEL });
}

/** Compile only named harness functions, without registering a live test. */
function reportHarnessSource(names: readonly string[], optionalNames: readonly string[] = []): string {
  const ast = ts.createSourceFile('report.real.spec.ts', source('report.real.spec.ts'), ts.ScriptTarget.Latest, true);
  const functions = [...names, ...optionalNames].map((name) => {
    const declaration = ast.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (declaration === undefined && !optionalNames.includes(name)) throw new Error(`report harness function missing: ${name}`);
    return declaration?.getText(ast) ?? '';
  });
  return ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** Exercise the actual pure diagnostic mapper without importing Playwright. */
function reportSectionDiagnostic(event: unknown, elapsedMs: number): unknown {
  const outputText = reportHarnessSource(['sectionDiagnostic']);
  return runInNewContext(`${outputText}\nsectionDiagnostic(event, elapsedMs);`, {
    event,
    elapsedMs,
    REPORT_SECTIONS,
  });
}

describe('real-model e2e specs', () => {
  // Changed 2026-10-15 (Harish): deepseek-v4-pro overloaded easily. Luna Pro is $0.10 in / $0.50
  // out per M (vs $0.39 / $0.78), with tools and reasoning, and is not the openai/gpt-6-luna
  // product default (see "neither product default" below).
  it('configure openai/gpt-6-luna-pro, the cheaper and steadier model on 2026-10-15', () => {
    expect(E2E_REAL_MODEL).toBe('openai/gpt-6-luna-pro');
  });

  it('assert the new product defaults by literal, not only against the constants', () => {
    expect([PRODUCT_DEFAULT_MODEL, PRODUCT_CHAT_DEFAULT_MODEL]).toEqual(['openai/gpt-6-luna', 'openai/gpt-6-luna']);
  });

  it("assert the app's real default models, one per tier", () => {
    expect(PRODUCT_DEFAULT_MODEL).toBe(RECOMMENDED_CLOUD_MODEL);
    expect(PRODUCT_CHAT_DEFAULT_MODEL).toBe(CHAT_CLOUD_MODEL);
  });

  // CONTRACT REVERSED 2026-10-15: neither default used to be the report engine's model. Harish
  // chose that pinned Luna as the reading and chat default, so all three share it.
  it("mirrors the report engine's own pinned model, which the reading and chat defaults now share", () => {
    expect(REPORT_ENGINE_DEFAULT_MODEL).toBe('openai/gpt-6-luna');
    expect(REPORT_ENGINE_DEFAULT_MODEL).toBe(REPORT_ENGINE_MODEL);
    expect(PRODUCT_DEFAULT_MODEL).toBe(REPORT_ENGINE_DEFAULT_MODEL);
    expect(PRODUCT_CHAT_DEFAULT_MODEL).toBe(REPORT_ENGINE_DEFAULT_MODEL);
  });

  it('runs full-report acceptance on the imported production report model by default', () => {
    expect(configuredReportModel({})).toBe(REPORT_ENGINE_MODEL);
    expect(configuredReportModel({ E2E_REAL_MODEL: 'unrelated-chat-override' })).toBe(REPORT_ENGINE_MODEL);
    expect(source('report.real.spec.ts')).toMatch(/import\s*\{[^}]*\bREPORT_ENGINE_MODEL\b[^}]*\}\s*from '@almamesh\/llm'/s);
  });

  it('preserves the dedicated REPORT_REAL_MODEL override', () => {
    expect(configuredReportModel({ REPORT_REAL_MODEL: E2E_REAL_MODEL })).toBe(E2E_REAL_MODEL);
    expect(configuredReportModel({ REPORT_REAL_MODEL: 'explicit/report-model' })).toBe('explicit/report-model');
  });

  it('configure a model that is neither product default, so "used the default, not the seeded model" can fail', () => {
    expect(E2E_REAL_MODEL).not.toBe(PRODUCT_DEFAULT_MODEL);
    expect(E2E_REAL_MODEL).not.toBe(PRODUCT_CHAT_DEFAULT_MODEL);
  });

  it('finds the real specs it guards', () => {
    expect(realSpecs()).toEqual(
      expect.arrayContaining([
        'chat.rag.real.spec.ts',
        'dashboard.agentic.real.spec.ts',
        'interpretation.heal.real.spec.ts',
        'interpretation.real.spec.ts',
        'report.real.spec.ts',
        'timeline.real.spec.ts',
      ]),
    );
  });

  it.each(realSpecs())('%s names no model id of its own', (spec) => {
    const allowed = new Set(ALLOWED_LITERALS[spec] ?? []);
    const named = [...new Set(source(spec).match(PROVIDER_SLUG) ?? [])];
    expect(named.filter((model) => !allowed.has(model))).toEqual([]);
  });

  // Covers aliases (RECOMMENDED_MODEL, CHAT_MODEL) and positional arguments too:
  // outside an assertion or a log line, the product default is never used.
  it.each(realSpecs())('%s never sends the product default model', (spec) => {
    expect(sendsProductDefault(source(spec))).toEqual([]);
  });
});

describe('live-report safe section diagnostics', () => {
  it.each(['section_start', 'section_complete'] as const)('records %s with section and elapsed time only', (type) => {
    expect(reportSectionDiagnostic({ type, section: 'guidance2', chart: 'private chart', messages: ['private prompt'] }, 123))
      .toEqual({ type, section: 'guidance2', elapsedMs: 123 });
  });

  it('records timeout and HTTP metadata without error messages or request contents', () => {
    const diagnostic = reportSectionDiagnostic({
      type: 'error', section: 'guidance2', status: 504,
      message: 'private prompt and key', timeout: { kind: 'total', limitMs: 300_000, secret: 'private' },
      chart: 'private chart', headers: { authorization: 'private key' },
    }, 300_042);
    expect(diagnostic).toEqual({
      type: 'error', section: 'guidance2', elapsedMs: 300_042,
      errorCode: 'SECTION_TIMEOUT', status: 504, timeoutKind: 'total', timeoutLimitMs: 300_000,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('classifies ordinary section errors without trusting arbitrary error fields', () => {
    expect(reportSectionDiagnostic({ type: 'error', section: 'core', status: 'private', code: 'private', timeout: { kind: 'private', limitMs: -1 } }, 12))
      .toEqual({ type: 'error', section: 'core', elapsedMs: 12, errorCode: 'SECTION_ERROR' });
  });

  it.each([null, { type: 'complete', section: 'core' }, { type: 'section_start', section: 'private-chart-id' }])('ignores non-section lifecycle data: %j', (event) => {
    expect(reportSectionDiagnostic(event, 1)).toBeNull();
  });
});

describe('hosted live-report diagnostic output', () => {
  it('prints a bounded closed metadata record without report, chart, prompt, key or raw failure contents', () => {
    const output: string[] = [];
    const events = Array.from({ length: REPORT_SECTIONS.length * 3 }, () => ({
      type: 'error', section: 'guidance2', elapsedMs: 300_001,
      errorCode: 'private-provider-error', status: 504, timeoutKind: 'total', timeoutLimitMs: 300_000,
      report: 'private-report', chart: 'private-chart', messages: ['private-prompt'],
      key: 'private-key', message: 'private-failure', provider: 'private-provider-request',
    }));
    runInNewContext(`${reportHarnessSource(['sectionDiagnostic', 'printRunDiagnostics'])}\nprintRunDiagnostics(3, events);`, {
      events, REPORT_SECTIONS, RUNS: 3, console: { log: (line: string) => output.push(line) },
    });
    expect(output).toHaveLength(1);
    const record = JSON.parse(output[0] as string) as { event: string; run: number; sections: unknown[] };
    expect(Object.keys(record).sort()).toEqual(['event', 'run', 'sections']);
    expect(record.event).toBe('report-run-diagnostics');
    expect(record.run).toBe(3);
    expect(record.sections).toHaveLength(REPORT_SECTIONS.length * 2);
    expect(record.sections.every((section) => JSON.stringify(section) === JSON.stringify({
      type: 'error', section: 'guidance2', elapsedMs: 300_001,
      errorCode: 'SECTION_TIMEOUT', status: 504, timeoutKind: 'total', timeoutLimitMs: 300_000,
    }))).toBe(true);
    expect(output.join('\n')).not.toContain('private');
  });

  it('rejects unsafe section identifiers and timing values before printing', () => {
    const output: string[] = [];
    runInNewContext(`${reportHarnessSource(['sectionDiagnostic', 'printRunDiagnostics'])}\nprintRunDiagnostics(1, events);`, {
      events: [
        { type: 'section_start', section: 'private-chart-id', elapsedMs: 1 },
        { type: 'section_complete', section: 'core', elapsedMs: 'private-timing' },
        { type: 'section_complete', section: 'core', elapsedMs: Number.NaN },
        { type: 'section_complete', section: 'core', elapsedMs: -1 },
        { type: 'section_complete', section: 'core', elapsedMs: 42 },
      ],
      REPORT_SECTIONS, RUNS: 3, console: { log: (line: string) => output.push(line) },
    });
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toEqual({
      event: 'report-run-diagnostics', run: 1,
      sections: [{ type: 'section_complete', section: 'core', elapsedMs: 42 }],
    });
  });

  it.each(['complete', 'section-failure', 'run-failure'] as const)('makes safe diagnostics available in stdout when a run ends with %s', async (outcome) => {
    const output: string[] = [];
    const streamNatalInterpretation = async function* () {
      yield { type: 'section_start', section: 'guidance2' };
      if (outcome === 'run-failure') throw new Error('private-run-failure');
      if (outcome === 'section-failure') {
        yield { type: 'error', section: 'guidance2', message: 'private-provider-failure', timeout: { kind: 'total', limitMs: 300_000 } };
      } else {
        yield { type: 'section_complete', section: 'guidance2' };
      }
      yield { type: 'complete', interpretation: { chart: 'private-chart', report: 'private-report' } };
    };
    const streamReportTimeline = async function* () {
      yield { type: 'complete', timeline: { report: 'private-report' }, dateGuardRemovals: 0 };
    };
    const result = await runInNewContext(`${reportHarnessSource(['sectionDiagnostic', 'drain', 'runOnce'], ['printRunDiagnostics'])}\nrunOnce(chart, config, pricing, 3);`, {
      chart: { private: 'private-chart' }, config: { apiKey: 'private-key' }, pricing: {},
      REPORT_SECTIONS, RUNS: 3, RUN_DEADLINE_MS: 600_000, REPORT_PROMPT_SET: {}, AS_OF: {},
      Date: { now: () => 1_000 }, setTimeout, clearTimeout, AbortController,
      streamNatalInterpretation, streamReportTimeline,
      catalogCostUsd: () => 0, reportSectionWords: () => ({ layman: 0, technical: 0 }), lostWordReplies: () => ({}),
      console: { log: (line: string) => output.push(line) },
      fetch: () => { throw new Error('Unit harness must not send provider requests'); },
    }) as { errors: string[] };
    expect(result.errors.length > 0).toBe(outcome !== 'complete');
    expect(output).toHaveLength(1);
    const record = JSON.parse(output[0] as string) as { event: string; run: number; sections: unknown[] };
    expect(record.event).toBe('report-run-diagnostics');
    expect(record.run).toBe(3);
    expect(record.sections[0]).toEqual({ type: 'section_start', section: 'guidance2', elapsedMs: 0 });
    if (outcome === 'section-failure') expect(record.sections[1]).toMatchObject({ errorCode: 'SECTION_TIMEOUT', timeoutKind: 'total', timeoutLimitMs: 300_000 });
    expect(output.join('\n')).not.toContain('private');
  });
});

describe('the send detector', () => {
  const alias = 'const RECOMMENDED_MODEL = PRODUCT_DEFAULT_MODEL;\n';

  it('counts a template literal that is only the alias as a send', () => {
    expect(sendsProductDefault(`${alias}await configure({ model: \`\${RECOMMENDED_MODEL}\` });`)).toEqual([
      'await configure({ model: `${RECOMMENDED_MODEL}` });',
    ]);
  });

  it('still exempts the alias interpolated into a message', () => {
    expect(
      sendsProductDefault(`${alias}test.info().annotations.push({ type: 'model', description: \`default \${RECOMMENDED_MODEL}\` });`),
    ).toEqual([]);
  });

  it('counts the alias passed bare', () => {
    expect(sendsProductDefault(`${alias}await configure({ model: RECOMMENDED_MODEL });`)).toHaveLength(1);
  });
});
