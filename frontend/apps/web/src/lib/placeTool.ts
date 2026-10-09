/**
 * resolve_place (spec 2026-10-08 Part 2): typed place text -> label + IANA zone
 * + a place_ref, from the bundled offline list only. Coordinates never enter a
 * result: the model sees only what the user typed, the label and the zone.
 */
import type { AgentJsonObject, AgentTool } from '@almamesh/llm';

import { lookupPlaceOffline, type PlaceLookup, type ResolvedPlace } from './geo/placeLookup';

export const RESOLVE_PLACE_TOOL_NAME = 'resolve_place';
export const RESOLVE_PLACE_STATUS_LABEL = 'Looking up the place on this device';
const QUERY_ERROR = 'query must be a place name of 2–120 characters';

const DESCRIPTION = [
  'Look up a city the user named, on this device only (no network). Returns a label, an IANA time zone and a place_ref.',
  'Pass place_ref to get_timing for a single day or a time of day. If several places are named, resolve them all in the same round.',
  'status "ambiguous": list the candidates and ask which one. status "not_found": ask for the nearest larger city.',
  'Never use this for the birth place.',
].join(' ');

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

export function createResolvePlaceTool(lookup: (query: string) => Promise<PlaceLookup> = lookupPlaceOffline): AgentTool {
  return {
    name: RESOLVE_PLACE_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: RESOLVE_PLACE_STATUS_LABEL,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject) => {
      const text = query(args);
      return text === undefined ? { error: QUERY_ERROR } : forModel(await lookup(text));
    },
  };
}
