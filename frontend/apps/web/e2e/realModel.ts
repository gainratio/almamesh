/**
 * Models for the `*.real.spec.ts` specs, which call live OpenRouter every night.
 *
 * E2E_REAL_MODEL is the model a real spec CONFIGURES. It is the cheapest model
 * that passes them. OpenRouter prices on 2026-10-09, per million tokens:
 *   deepseek/deepseek-v4-pro      $0.209 in / $0.418 out   <- cheapest
 *   deepseek/deepseek-v4.1-flash  $0.30  in / $1.20  out
 * Re-check the prices before changing it.
 *
 * PRODUCT_DEFAULT_MODEL is what the APP picks on its own (its recommended cloud
 * model, which chat also defaults to). Specs only ASSERT it; they never
 * configure it. src/test/realModelSpecs.contract.test.ts pins both values and
 * fails on any other model id in a real spec.
 */
export const E2E_REAL_MODEL = 'deepseek/deepseek-v4-pro';

/** Mirrors `RECOMMENDED_CLOUD_MODEL` / `CHAT_CLOUD_MODEL` in @almamesh/llm. */
export const PRODUCT_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
