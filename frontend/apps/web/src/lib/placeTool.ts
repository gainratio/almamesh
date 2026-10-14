/**
 * resolve_place (spec 2026-10-08 Part 2): typed place text -> label + IANA zone
 * + a place_ref, from the bundled offline list only. Coordinates never enter a
 * result: the model sees only what the user typed, the label and the zone.
 * When several places match, the person picks one in the chat's place picker
 * (placePick.ts) and the tool waits; the model never guesses between them.
 */
import { AGENT_LIMITS, type AgentJsonObject, type AgentTool } from '@almamesh/llm';

import type { PlaceLookup, ResolvedPlace } from './geo/placeLookup';
import { askToPickPlace, NO_PLACE_PICKER } from './placePick';

type PickPlace = typeof askToPickPlace;

export const RESOLVE_PLACE_TOOL_NAME = 'resolve_place';
export const RESOLVE_PLACE_STATUS_LABEL = 'Looking up the place on this device';
/**
 * A cold, bounded SQLite import can outlast the ordinary small-tool deadline,
 * and a person choosing between Springfields needs time: the longest any tool may run.
 */
export const PLACE_LOOKUP_TIMEOUT_MS = AGENT_LIMITS.maxToolTimeoutMs;
const QUERY_ERROR = 'query must be a place name of 2–120 characters';

const DESCRIPTION = [
  'Look up a city the user named, on this device only (no network). Returns a label, an IANA time zone and a place_ref.',
  'Pass place_ref to get_timing for a single day or a time of day. If several places are named, resolve them all in the same round.',
  'status "ambiguous": list the candidates and ask which one. status "not_found": ask for the nearest larger city.',
  'Never use this for the birth place.',
].join(' ');

/** The offline lookup, loaded on first use so the geo module stays out of the chat chunk. */
const lazyLookup = (text: string): Promise<PlaceLookup> => import('./geo/placeLookup').then((geo) => geo.lookupPlaceOffline(text));

function query(args: AgentJsonObject): string | undefined {
  const value = args.query;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 2 && value.length <= 120 ? trimmed : undefined;
}

function forModel(result: PlaceLookup): AgentJsonObject {
  const summary = (place: ResolvedPlace) => place.summary;
  if (result.status === 'found') return { status: 'found', place: summary(result.place) };
  if (result.status === 'ambiguous') return { status: 'ambiguous', candidates: result.candidates.map(summary) };
  return { status: 'not_found' };
}

/**
 * Several places: let the person pick. Their pick is found; a cancel is a
 * neutral not_picked that says what to do itself, so the description (and
 * every request) stays the size it was.
 */
const NOT_PICKED = {
  status: 'not_picked',
  note: 'The person closed the place picker without choosing. Do not guess a place: answer what needs none, or ask where they mean.',
} as const;

async function settle(text: string, candidates: readonly ResolvedPlace[], pick: PickPlace, signal: AbortSignal): Promise<AgentJsonObject> {
  const picked = await pick(text, candidates, signal);
  if (picked === NO_PLACE_PICKER) return forModel({ status: 'ambiguous', candidates });
  return picked ? forModel({ status: 'found', place: picked }) : { ...NOT_PICKED };
}

export function createResolvePlaceTool(lookup: (query: string) => Promise<PlaceLookup> = lazyLookup, pick: PickPlace = askToPickPlace): AgentTool {
  return {
    name: RESOLVE_PLACE_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: RESOLVE_PLACE_STATUS_LABEL,
    timeoutMs: PLACE_LOOKUP_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject, context) => {
      context.signal.throwIfAborted();
      const text = query(args);
      if (text === undefined) return { error: QUERY_ERROR };
      const found = await lookup(text);
      context.signal.throwIfAborted();
      if (found.status !== 'ambiguous') return forModel(found);
      const answer = await settle(text, found.candidates, pick, context.signal);
      context.signal.throwIfAborted();
      return answer;
    },
  };
}
