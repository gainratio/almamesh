/**
 * Models for the `*.real.spec.ts` specs, which call live OpenRouter every night.
 *
 * E2E_REAL_MODEL is the model a real spec CONFIGURES: a cheap model that passes them and does not
 * overload. OpenRouter prices on 2026-10-15, per million tokens:
 *   openai/gpt-6-luna             $0.10 in / $0.50 out   <- chosen (tools + reasoning)
 *   deepseek/deepseek-v4-pro      $0.39 in / $0.78 out   (overloaded easily; the model until 2026-10-15)
 * It is Luna's pinned version, not the `~openai/gpt-luna-latest` alias the app defaults to, so a spec
 * that asserts "the app used its default, not the seeded model" can still fail; with no chat
 * override, the real specs' chat runs on the alias (the product default) itself.
 * Re-check the prices before changing it.
 *
 * PRODUCT_DEFAULT_MODEL is the reading model the APP picks on its own (its
 * recommended cloud model); PRODUCT_CHAT_DEFAULT_MODEL is its chat default.
 * The two differ on purpose. Specs only ASSERT them; they never configure them. src/test/realModelSpecs.contract.test.ts pins both values and
 * fails on any other model id in a real spec.
 */
export const E2E_REAL_MODEL = 'openai/gpt-6-luna';

/** Mirrors `RECOMMENDED_CLOUD_MODEL` in @almamesh/llm (readings). */
export const PRODUCT_DEFAULT_MODEL = '~openai/gpt-luna-latest';

/** Mirrors `CHAT_CLOUD_MODEL` in @almamesh/llm (chat). */
export const PRODUCT_CHAT_DEFAULT_MODEL = '~openai/gpt-luna-latest';

/**
 * Mirrors `REPORT_ENGINE_MODEL` in @almamesh/llm: the nine-section report engine's
 * own pinned model. The legacy reading and chat do NOT use it. A report-engine real
 * run that wants the product's report default sets REPORT_REAL_MODEL to this.
 */
export const REPORT_ENGINE_DEFAULT_MODEL = 'openai/gpt-6-luna';

/**
 * The trip/today acceptance matrix (e2e/trip-acceptance.real.spec.ts) runs every question on
 * these models: the e2e model and OpenAI's newest (the stated acceptance pair, 2026-10-14; the e2e
 * model is gpt-luna since 2026-10-15). OpenRouter lists the OpenAI alias with a leading "~".
 */
export const TRIP_ACCEPTANCE_MODELS: readonly string[] = [E2E_REAL_MODEL, '~openai/gpt-sol-latest'];
