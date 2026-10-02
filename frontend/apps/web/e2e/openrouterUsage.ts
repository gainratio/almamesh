/**
 * Read what a live OpenRouter completion cost and how long the model thought,
 * from the raw response body (an SSE stream or one JSON body). Used by the
 * [real] specs to record cost per run next to their timings.
 */

export interface CompletionUsage {
  /** Assembled answer text (content deltas, or the single message content). */
  readonly content: string;
  /** Words of streamed reasoning ("thinking") text. */
  readonly reasoningWords: number;
  /** USD cost OpenRouter reported in `usage.cost`, or 0 when absent. */
  readonly cost: number;
  readonly reasoningTokens: number;
  readonly completionTokens: number;
  readonly promptTokens: number;
  /** The upstream provider OpenRouter routed to (prices differ per provider). */
  readonly provider: string;
}

interface UsageRow {
  readonly cost?: number;
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

interface Payload {
  readonly usage?: UsageRow;
  readonly provider?: string;
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: unknown; readonly reasoning?: unknown };
    readonly message?: { readonly content?: unknown; readonly reasoning?: unknown };
  }>;
}

function payloadsOf(body: string): Payload[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as Payload];
    } catch {
      return [];
    }
  }
  const out: Payload[] = [];
  for (const line of body.split('\n')) {
    const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    try {
      out.push(JSON.parse(data) as Payload);
    } catch {
      // A torn line in a captured body: skip it, the totals stay best-effort.
    }
  }
  return out;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function completionUsage(body: string): CompletionUsage {
  let content = '';
  let reasoning = '';
  let usage: UsageRow | undefined;
  let provider = '';
  for (const p of payloadsOf(body)) {
    provider = p.provider ?? provider;
    const choice = p.choices?.[0];
    content += text(choice?.delta?.content) + text(choice?.message?.content);
    reasoning += text(choice?.delta?.reasoning) + text(choice?.message?.reasoning);
    if (p.usage) usage = p.usage;
  }
  return {
    content,
    reasoningWords: reasoning.split(/\s+/).filter(Boolean).length,
    cost: usage?.cost ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    promptTokens: usage?.prompt_tokens ?? 0,
    provider,
  };
}
