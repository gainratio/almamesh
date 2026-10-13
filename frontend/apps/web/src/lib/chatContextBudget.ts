/**
 * One seam for a chat turn's context budget (spec 2026-10-13, "Context budget
 * for the agentic loop"): the chat model's context window (a configured value,
 * else OpenRouter's catalog `context_length`, else unknown = 8k), the composed
 * prompt's sizing for that window, and the per-round telemetry sink. Dashboard
 * and MeshEdge chat both take their budget from here.
 */
import {
  chatPromptBudgetFor,
  readLlmSettings,
  resolveModelContextTokens,
  type AgentRoundUsage,
  type ChatPromptBudget,
  type ProviderConfig,
} from '@almamesh/llm';

import { beginAgentTurn } from './agentRoundTelemetry';

export interface ChatTurnContext {
  /** The model's context window; undefined when unknown (the agent loop assumes 8k). */
  readonly contextTokens: number | undefined;
  readonly promptBudget: ChatPromptBudget;
  readonly onRoundUsage: (usage: AgentRoundUsage) => void;
}

export async function chatContextFor(config: ProviderConfig, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<ChatTurnContext> {
  const contextTokens = await resolveModelContextTokens({
    config,
    configured: readLlmSettings().chatContextTokens,
    ...(signal ? { signal } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { contextTokens, promptBudget: chatPromptBudgetFor(contextTokens), onRoundUsage: beginAgentTurn() };
}
