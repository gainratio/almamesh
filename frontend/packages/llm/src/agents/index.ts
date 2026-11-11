// ChatAgent orchestrator: selects relevant domain specialists for a user turn
// and composes their concise, deterministic-first guidance and tool list.

import {
  MeshSynastryAgent,
  NatalChartAgent,
  RectificationAdvisorAgent,
  TimingPanchangAgent,
} from "./specialists";
import type { AgentId, AgentSpecialist, AgentTurnContext, TurnAgentPlan } from "./types";

export type { AgentId, AgentSpecialist, AgentTurnContext, SpecialistAgentId, TurnAgentPlan } from "./types";
export {
  MeshSynastryAgent,
  NatalChartAgent,
  RectificationAdvisorAgent,
  TimingPanchangAgent,
} from "./specialists";

export const ALL_SPECIALISTS: readonly AgentSpecialist[] = Object.freeze([
  TimingPanchangAgent,
  NatalChartAgent,
  MeshSynastryAgent,
  RectificationAdvisorAgent,
]);

const LOCATION_INTENT =
  /\b(?:i\s+am\s+in|i['’]m\s+in|i\s+live\s+in|living\s+in|moved\s+to|based\s+in|located\s+in|here\s+in|current\s+(?:location|city|place)|set\s+(?:my\s+)?(?:location|city)|my\s+city\s+is|estoy\s+en|vivo\s+en|moro\s+em|estou\s+em)\b|(?:मैं\s+.+\s+में)/iu;

const BEST_WINDOWS_INTENT =
  /\b(?:best\s+(?:window|windows|time|times|months|period|periods)|favorable\s+(?:window|windows|time|months)|good\s+(?:window|windows|months)|upcoming\s+(?:window|windows)|find_best_windows|next\s+(?:3|6|12|24)\s+months|(?:career|financ\w*|relationship\w*|health|spiritual\w*|educat\w*|family)\s+(?:window|windows|forecast)|when\s+(?:should|to)\s+(?:i\s+)?(?:switch|launch|apply|invest|marry|move|start)|ashtakavarga|sarvashtakavarga|bindu|bindus)\b/iu;

const MEMORY_INTENT =
  /\b(?:remember(?:\s+that)?|keep\s+in\s+mind|note\s+that|save\s+this|for\s+(?:my\s+)?context|i['’]?m\s+(?:building|starting|launching|preparing|studying|working\s+on)|i\s+am\s+(?:building|starting|launching|preparing|studying|working\s+on)|i\s+work\s+as|my\s+(?:startup|goal|focus|practice)\s+is|recuerda|lembre)\b|(?:याद\s+रख)/iu;

function selectRecommendedTools(
  trimmed: string,
  active: readonly AgentSpecialist[],
  context?: AgentTurnContext,
): readonly string[] {
  if (context?.hasTrip) return ["read_period"];
  const tools = new Set<string>(["read_period"]);
  if (LOCATION_INTENT.test(trimmed) || (!context?.hasHomePlace && context?.lastAssistantAskedPlace)) {
    tools.add("set_current_location");
  }
  if (active.some((a) => a.id === "natal_varga" || a.id === "rectification_advisor")) {
    tools.add("read_varga");
  }
  if (BEST_WINDOWS_INTENT.test(trimmed)) {
    tools.add("find_best_windows");
  }
  if (active.some((a) => a.id === "mesh_synastry")) {
    tools.add("read_mesh_member");
  }
  if (MEMORY_INTENT.test(trimmed)) {
    tools.add("remember_fact");
  }
  return [...tools];
}

export function selectSpecialistsForTurn(query: string, context?: AgentTurnContext): TurnAgentPlan {
  const trimmed = query.trim();
  const active = trimmed === "" ? [] : ALL_SPECIALISTS.filter((agent) => agent.matches(trimmed, context));
  const primaryAgent: AgentId = active[0]?.id ?? "chat_orchestrator";
  const badgeLabel =
    active.length === 0
      ? "AlmaMesh Companion"
      : active.length === 1
        ? active[0]!.label
        : `${active[0]!.label} +${active.length - 1}`;
  const specialistBlock = active.map((agent) => agent.instructions).join("\n\n");
  const enforceRelationshipFence = active.some((agent) => agent.enforceRelationshipFence === true);
  const recommendedTools = selectRecommendedTools(trimmed, active, context);
  return {
    primaryAgent,
    activeSpecialists: active,
    badgeLabel,
    specialistBlock,
    enforceRelationshipFence,
    recommendedTools,
  };
}

export const ChatAgent = Object.freeze({
  id: "chat_orchestrator" as const,
  label: "AlmaMesh Companion",
  specialists: ALL_SPECIALISTS,
  planTurn: selectSpecialistsForTurn,
});
