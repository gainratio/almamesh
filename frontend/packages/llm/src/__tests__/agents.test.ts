import { describe, expect, it } from "vitest";

import {
  ALL_SPECIALISTS,
  ChatAgent,
  MeshSynastryAgent,
  NatalChartAgent,
  RectificationAdvisorAgent,
  TimingPanchangAgent,
  selectSpecialistsForTurn,
} from "../agents";

describe("specialist agent routing (selectSpecialistsForTurn)", () => {
  it("falls back to chat_orchestrator on open-ended reflective chat", () => {
    const plan = selectSpecialistsForTurn("Hello, tell me about my general strengths");
    expect(plan.primaryAgent).toBe("chat_orchestrator");
    expect(plan.activeSpecialists).toEqual([]);
    expect(plan.badgeLabel).toBe("AlmaMesh Companion");
    expect(plan.specialistBlock).toBe("");
    expect(plan.enforceRelationshipFence).toBe(false);
  });

  it("activates TimingPanchangAgent on weekly status & panchang queries", () => {
    const plan = selectSpecialistsForTurn("What is my status for this week?");
    expect(plan.primaryAgent).toBe("timing_panchang");
    expect(plan.activeSpecialists).toContain(TimingPanchangAgent);
    expect(plan.specialistBlock).toContain('start="this_week"');
  });

  it("activates NatalChartAgent and RectificationAdvisorAgent on unrectified D60 query", () => {
    const plan = selectSpecialistsForTurn("Deep dive my D9 and D60 Shashtiamsa", { isRectified: false });
    expect(plan.activeSpecialists).toContain(NatalChartAgent);
    expect(plan.activeSpecialists).toContain(RectificationAdvisorAgent);
    expect(plan.badgeLabel).toBe("Natal & Varga +1");
    expect(plan.specialistBlock).toContain("read_varga");
    expect(plan.specialistBlock).toContain("approx_minutes_to_cusp");
  });

  it("skips RectificationAdvisorAgent on D60 when already rectified unless explicitly asked", () => {
    const plan = selectSpecialistsForTurn("Show my D60 placements", { isRectified: true });
    expect(plan.activeSpecialists).toEqual([NatalChartAgent]);
  });

  it("activates MeshSynastryAgent and enforces relationship fence on partner/synastry queries", () => {
    const plan = selectSpecialistsForTurn("How compatible am I with my spouse?");
    expect(plan.primaryAgent).toBe("mesh_synastry");
    expect(plan.activeSpecialists).toContain(MeshSynastryAgent);
    expect(plan.enforceRelationshipFence).toBe(true);
    expect(plan.specialistBlock).toContain("read_mesh_member");
  });

  it("exposes all four concrete specialists and selective tool mounting via ChatAgent", () => {
    expect(ALL_SPECIALISTS).toHaveLength(4);
    expect(ChatAgent.specialists).toBe(ALL_SPECIALISTS);
    expect(ChatAgent.planTurn("Is my birth time on a cusp?").activeSpecialists).toContain(RectificationAdvisorAgent);
    expect(ChatAgent.planTurn("I am in Novato, CA — status for this week?").recommendedTools).toEqual([
      "read_period",
      "set_current_location",
    ]);
    expect(ChatAgent.planTurn("Best career windows next 6 months").recommendedTools).toContain("find_best_windows");
    expect(ChatAgent.planTurn("Deep dive my D9 and D60").recommendedTools).toContain("read_varga");
    expect(ChatAgent.planTurn("How compatible am I with my spouse?").recommendedTools).toContain("read_mesh_member");
    expect(ChatAgent.planTurn("Remember that I'm building an AI startup").recommendedTools).toContain("remember_fact");
  });
});
