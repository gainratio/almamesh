// Concrete Vedic astrology specialists composed into the ChatAgent prompt per turn.
// Zero astrology math here: specialists guide tool selection and factual grounding only.

import type { AgentSpecialist, AgentTurnContext } from "./types";

const TIMING_PATTERN =
  /\b(today|tomorrow|this[\s_-]?week|next[\s_-]?(?:7|14)[\s_-]?days|this[\s_-]?month|week|weekly|outlook|status|panchang|panchanga|tithi|nakshatra|tarabala|tara\b|chandrabala|vara\b|yoga\b|karana|dasha|mahadasha|antardasha|pratyantar|bhukti|gochara|transit|sade[\s_-]?sati|window|best[\s_-]?time|when\b|upcoming|forecast|month|year|20\d{2}|relocat|travel|trip)\b/iu;

const VARGA_PATTERN =
  /\b(d(?:1|2|3|4|7|9|10|12|16|20|24|27|30|40|45|60)|varga|vargas|divisional|navamsa|navamsha|dasamsa|dashamsha|shashtiamsa|shastiamsa|saptamsa|drekkana|hora|dwadasamsa|shodasamsa|vimsamsa|chaturvimsamsa|trimsamsa|khavedamsa|akshavedamsa|vargottama|vimshopaka|shadbala|ashtakavarga|bindu|amsa|lagna|ascendant|dignity|exalted|debilitated)\b/iu;

const MESH_PATTERN =
  /\b(mesh|synastry|compatib|ashtakoota|guna|gunas|koota|melapaka|mangal|manglik|kuja[\s_-]?dosha|spouse|husband|wife|partner|boyfriend|girlfriend|fiance|fianc[eé]e|marriage[\s_-]?match|relationship[\s_-]?with|mother|father|parent|child|son|daughter|sibling|brother|sister|co-?founder|business[\s_-]?partner)\b/iu;

const RECTIFICATION_PATTERN =
  /\b(rectif|birth[\s_-]?time|birthtime|time[\s_-]?of[\s_-]?birth|exact[\s_-]?time|hospital[\s_-]?time|cusp|borderline|unsure[\s_-]?of[\s_-]?time|uncertain[\s_-]?time|wrong[\s_-]?time|rounded[\s_-]?time)\b/iu;

const SENSITIVE_VARGA_PATTERN = /\b(d60|shashtiamsa|shastiamsa|d40|d45)\b/iu;

export const TimingPanchangAgent: AgentSpecialist = {
  id: "timing_panchang",
  label: "Timing & Panchang",
  recommendedTools: ["read_period", "find_best_windows", "set_current_location"],
  instructions: [
    "SPECIALIST (TIMING & PANCHANG):",
    '- For "this week" / "status for this week" / "next 7 days", call read_period ONCE with start="this_week" (7 local civil days [today, today + 6 days] inclusive).',
    "- When a reading includes `daily` Panchang rows, highlight supportive vs mindful days using the engine's tithi_name, paksha, nakshatra, and Tarabala/Chandrabala day_quality alongside active Maha/Antar/Pratyantar dashas.",
    "- When `place_note` indicates device-timezone fallback, mention calmly that setting a current city unlocks local rising-sign timing.",
    "- For multi-month domain outlook questions (e.g. best career or financial windows), call find_best_windows.",
  ].join("\n"),
  matches: (query: string, context?: AgentTurnContext): boolean =>
    !context?.hasTrip && TIMING_PATTERN.test(query),
};

export const NatalChartAgent: AgentSpecialist = {
  id: "natal_varga",
  label: "Natal & Varga",
  recommendedTools: ["read_varga"],
  instructions: [
    "SPECIALIST (NATAL & DIVISIONAL VARGAS):",
    "- Call read_varga to inspect divisional charts (D1 Rasi, D9 Navamsa, D10 Dasamsa, D60 Shashtiamsa, etc.) directly from the deterministic Python engine.",
    "- State Varga Lagna, sign lord, planetary houses, exact dignity, Vargottama status, active Dasha lords in that Varga, and D60 Shashtiamsa amsa names/natures (saumya vs krura) strictly from the tool result.",
    "- Never compute or guess divisional placements yourself.",
  ].join("\n"),
  matches: (query: string): boolean => VARGA_PATTERN.test(query),
};

export const MeshSynastryAgent: AgentSpecialist = {
  id: "mesh_synastry",
  label: "Mesh Synastry",
  recommendedTools: ["read_mesh_member"],
  enforceRelationshipFence: true,
  instructions: [
    "SPECIALIST (MESH SYNASTRY):",
    "- Call read_mesh_member to load deterministic relationship synastry (Ashtakoota /36 gunas, doshas & cancellations, Mangal screening, chart overlays, and mutual Dasha synchrony).",
    '- If status is "empty_mesh", invite the user to add their person on AlmaMesh (/mesh) without inventing compatibility facts.',
    '- Refer to the other person strictly by relationship role (e.g. "your spouse", "your friend #1"), NEVER by personal name.',
  ].join("\n"),
  matches: (query: string, context?: AgentTurnContext): boolean =>
    Boolean(context?.hasMeshEdge) || MESH_PATTERN.test(query),
};

export const RectificationAdvisorAgent: AgentSpecialist = {
  id: "rectification_advisor",
  label: "Birth-Time Sensitivity",
  recommendedTools: ["read_varga"],
  instructions: [
    "SPECIALIST (BIRTH-TIME SENSITIVITY & RECTIFICATION):",
    "- When discussing cusp-sensitive charts (especially D60 ~2 min window, or near-cusp D9/D10), cite the engine's `sensitivity` fields (`approx_minutes_to_cusp`, `nominal_window_minutes`, `high_time_sensitivity`) transparently.",
    "- Never declare or guess a 'true birth time'. When the profile is unrectified and sensitivity is high, note that AlmaMesh's life-event Rectification workflow can test working birth-time hypotheses.",
  ].join("\n"),
  matches: (query: string, context?: AgentTurnContext): boolean =>
    RECTIFICATION_PATTERN.test(query) || (!context?.isRectified && SENSITIVE_VARGA_PATTERN.test(query)),
};
