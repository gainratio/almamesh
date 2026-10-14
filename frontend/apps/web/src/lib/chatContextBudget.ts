/**
 * One seam for a chat turn's context budget (spec 2026-10-13, "Context budget
 * for the agentic loop"): the chat model's context window (a configured value,
 * else OpenRouter's catalog `context_length`, else unknown = 8k), the composed
 * prompt's sizing for that window, and the per-round and per-call telemetry sinks. Dashboard
 * and MeshEdge chat both take their budget from here.
 */
import { chatPromptBudgetFor, readLlmSettings, resolveModelContextTokens, type ChatPromptBudget, type ProviderConfig } from '@almamesh/llm';

import { beginAgentTurn, type AgentTurnTelemetry } from './agentRoundTelemetry';

export interface ChatTurnContext {
  readonly promptBudget: ChatPromptBudget;
  /** Dev telemetry of the turn's rounds and tool calls (lib/agentRoundTelemetry.ts). */
  readonly telemetry: AgentTurnTelemetry;
}

export async function chatContextFor(config: ProviderConfig, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<ChatTurnContext> {
  const contextTokens = await resolveModelContextTokens({
    config,
    configured: readLlmSettings().chatContextTokens,
    ...(signal ? { signal } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { promptBudget: chatPromptBudgetFor(contextTokens), telemetry: beginAgentTurn() };
}
