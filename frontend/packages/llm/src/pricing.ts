// Per-token model pricing from the OpenRouter catalog. Pure LEAF module: no
// runtime imports, so client.ts can depend on it without any import cycle
// (reasoning.ts extends LlmRequestError from client at load time). A missing,
// unparseable or negative price yields NO number, never a guess.

import type { OpenRouterModel } from "./client";

export interface ModelPricing {
  readonly promptUsdPerToken: number;
  readonly completionUsdPerToken: number;
}

function usdPerToken(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** OpenRouter `/models` `pricing` ({ prompt, completion } as decimal USD-per-token strings). */
export function parseModelPricing(raw: unknown): ModelPricing | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const prompt = usdPerToken(row.prompt);
  const completion = usdPerToken(row.completion);
  return prompt === undefined || completion === undefined
    ? undefined
    : { promptUsdPerToken: prompt, completionUsdPerToken: completion };
}

/** The configured model's price, or null when the catalog has no usable price for it. */
export function findModelPricing(
  models: readonly OpenRouterModel[],
  modelId: string,
): ModelPricing | null {
  return models.find((model) => model.id === modelId)?.pricing ?? null;
}
