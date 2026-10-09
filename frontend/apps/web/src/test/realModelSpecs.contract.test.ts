/**
 * Every e2e spec that calls a REAL model (`e2e/*.real.spec.ts`, run by the
 * nightly against live OpenRouter) must use the cheapest model. The nightly
 * pays for every one of these calls, every night.
 *
 * The check reads the spec sources: any OpenRouter-style model slug they name
 * (a literal, an env-override fallback, or a seeded config) must be
 * `deepseek/deepseek-v4.1-flash`. The one allowed exception is the retired slug
 * the self-heal spec seeds on purpose; the app rewrites it before any call.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHEAPEST_MODEL = 'deepseek/deepseek-v4.1-flash';
const E2E_DIR = resolve(__dirname, '../../e2e');

/** Slugs a real spec may name besides the cheapest model, and why. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // The stale model the self-heal spec seeds; never sent to the provider.
  'interpretation.heal.real.spec.ts': ['anthropic/claude-3.5-sonnet'],
};

const PROVIDER_SLUG =
  /\b(?:deepseek|anthropic|openai|google|meta-llama|mistralai|qwen|x-ai|z-ai|moonshotai|cohere|nvidia|microsoft|amazon|minimax|openrouter)\/[\w.:-]+/g;

function realSpecs(): string[] {
  return readdirSync(E2E_DIR).filter((name) => name.endsWith('.real.spec.ts'));
}

function namedModels(source: string): string[] {
  return [...new Set(source.match(PROVIDER_SLUG) ?? [])];
}

describe('real-model e2e specs', () => {
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

  it.each(realSpecs())('%s names only deepseek/deepseek-v4.1-flash', (spec) => {
    const source = readFileSync(join(E2E_DIR, spec), 'utf8');
    const allowed = new Set([CHEAPEST_MODEL, ...(ALLOWED[spec] ?? [])]);
    expect(namedModels(source).filter((model) => !allowed.has(model))).toEqual([]);
  });
});
