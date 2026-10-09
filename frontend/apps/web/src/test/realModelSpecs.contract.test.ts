/**
 * Every e2e spec that calls a REAL model (`e2e/*.real.spec.ts`, run by the
 * nightly against live OpenRouter) configures the cheapest model, the one
 * constant `E2E_REAL_MODEL` in e2e/realModel.ts (prices and date are there).
 *
 * - The constant itself is pinned to its literal.
 * - A real spec names no model id of its own: models come from e2e/realModel.ts
 *   (env-override fallbacks included). The one exception is the retired slug
 *   the self-heal spec seeds on purpose; the app rewrites it before any call.
 * - `PRODUCT_DEFAULT_MODEL` (what the app picks itself) is only ever asserted,
 *   never configured, and must match the app's real default.
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
/** The product default used as a value the test SENDS, not one it expects. */
const CONFIGURES_PRODUCT_DEFAULT = /\b(?:model|chatModel)\s*:\s*PRODUCT_DEFAULT_MODEL/;

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

  it.each(realSpecs())('%s never configures the product default model', (spec) => {
    expect(source(spec)).not.toMatch(CONFIGURES_PRODUCT_DEFAULT);
  });
});
