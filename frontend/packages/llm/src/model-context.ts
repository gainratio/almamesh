// Where the agent loop's context window comes from (spec 2026-10-13, "Context
// budget for the agentic loop", rule 1): a configured value first; on OpenRouter,
// the chat model's `context_length` from the public model catalog (the same
// keyless read the model picker makes, to the endpoint the chat already talks
// to); otherwise unknown, and the loop assumes a small 8k window.

import { fetchOpenRouterModels } from "./client";
import { OPENROUTER_API_BASE, type ProviderConfig } from "./config";

export interface ResolveModelContextOptions {
  readonly config: ProviderConfig;
  /** A context window the person configured (custom or local endpoints). */
  readonly configured?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** One catalog read per endpoint per session; a failed read is dropped so the next turn retries. */
const catalogs = new Map<string, Promise<ReadonlyMap<string, number>>>();

function readCatalog(options: ResolveModelContextOptions): Promise<ReadonlyMap<string, number>> {
  const key = options.config.baseUrl;
  const cached = catalogs.get(key);
  if (cached) return cached;
  // The catalog is public: the key is never sent with it.
  const { apiKey: _key, ...keyless } = options.config;
  const read = fetchOpenRouterModels({ config: keyless, fetchImpl: options.fetchImpl, signal: options.signal })
    .then((models) => new Map(models.flatMap((model) => (model.contextLength ? [[model.id, model.contextLength] as const] : []))));
  catalogs.set(key, read);
  read.catch(() => catalogs.delete(key));
  return read;
}

/** The chat model's context window in tokens, or undefined when it cannot be known. */
export async function resolveModelContextTokens(options: ResolveModelContextOptions): Promise<number | undefined> {
  const { configured, config } = options;
  if (configured !== undefined && Number.isSafeInteger(configured) && configured > 0) return configured;
  if (!config.baseUrl.startsWith(OPENROUTER_API_BASE)) return undefined;
  try {
    return (await readCatalog(options)).get(config.model);
  } catch {
    // The window is an optimization input: an unreadable catalog means "assume small".
    return undefined;
  }
}
