/**
 * Every e2e spec that calls a REAL model (`e2e/*.real.spec.ts`, run by the
 * nightly against live OpenRouter) configures the cheapest model, the one
 * constant `E2E_REAL_MODEL` in e2e/realModel.ts (prices and date are there).
 *
 * - The constant itself is pinned to its literal.
 * - A real spec names no model id of its own: models come from e2e/realModel.ts
 *   (env-override fallbacks included). The one exception is the retired slug
 *   the self-heal spec seeds on purpose; the app rewrites it before any call.
 * - `PRODUCT_DEFAULT_MODEL` (what the app picks itself) and any alias of it is
 *   only ever asserted or logged, never configured or passed along, and it
 *   must match the app's real default.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHAT_CLOUD_MODEL, RECOMMENDED_CLOUD_MODEL } from '@almamesh/llm';

import { E2E_REAL_MODEL, PRODUCT_DEFAULT_MODEL } from '../../e2e/realModel';

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
  const names = new Set(['PRODUCT_DEFAULT_MODEL']);
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
    new RegExp(`\\$\\{${name}\\b`).test(line)
  );
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

describe('real-model e2e specs', () => {
  it('configure deepseek/deepseek-v4-pro, the cheapest model on 2026-10-09', () => {
    expect(E2E_REAL_MODEL).toBe('deepseek/deepseek-v4-pro');
  });

  it("assert the app's real default model", () => {
    expect(PRODUCT_DEFAULT_MODEL).toBe(RECOMMENDED_CLOUD_MODEL);
    expect(PRODUCT_DEFAULT_MODEL).toBe(CHAT_CLOUD_MODEL);
  });

  it('finds the real specs it guards', () => {
    expect(realSpecs()).toEqual(
      expect.arrayContaining([
        'chat.rag.real.spec.ts',
        'dashboard.agentic.real.spec.ts',
        'interpretation.heal.real.spec.ts',
        'interpretation.real.spec.ts',
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
