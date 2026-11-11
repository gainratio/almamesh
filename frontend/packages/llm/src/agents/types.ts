// Specialist agent contracts for AlmaMesh chat orchestration.
// Keep interfaces narrow, pure, and free of SDK/zod imports.

export type AgentId =
  | "chat_orchestrator"
  | "timing_panchang"
  | "natal_varga"
  | "mesh_synastry"
  | "rectification_advisor";

export type SpecialistAgentId = Exclude<AgentId, "chat_orchestrator">;

export interface AgentTurnContext {
  readonly hasHomePlace?: boolean;
  readonly hasTrip?: boolean;
  readonly hasMeshEdge?: boolean;
  readonly hasMeshMembers?: boolean;
  readonly isRectified?: boolean;
  readonly lastAssistantAskedPlace?: boolean;
}

export interface AgentSpecialist {
  readonly id: SpecialistAgentId;
  readonly label: string;
  readonly recommendedTools: readonly string[];
  readonly instructions: string;
  readonly enforceRelationshipFence?: boolean;
  matches(query: string, context?: AgentTurnContext): boolean;
}

export interface TurnAgentPlan {
  readonly primaryAgent: AgentId;
  readonly activeSpecialists: readonly AgentSpecialist[];
  readonly badgeLabel: string;
  readonly specialistBlock: string;
  readonly enforceRelationshipFence: boolean;
  readonly recommendedTools: readonly string[];
}
