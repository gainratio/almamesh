/**
 * One gate for every place_ref a chat tool reads (2026-10-14). A ref is stateless
 * ("city:<row>" in the bundled list), so any made-up number names a real city: live on
 * ba4430ce the model sent "city:0" and get_timing read it as Shanghai. A ref is read as
 * itself only when resolve_place handed it out in this turn (a trip's reserved "pinned" is
 * read by pinnedPlaceReader before this gate).
 *
 * Any other ref reads the THREAD's place: the trip's place, or today's current place
 * (2026-10-14, Harish's 09:22 PT turn: refusing it turned two reads into error rows and the
 * model gave up). The result says so in `place_note`. With no thread place the ref is still
 * refused, and the error lists the valid refs. It never reads a city from the list.
 */
import { PLACE_REF_ERROR, type AgentJsonObject, type AgentTool } from '@almamesh/llm';

import type { ResolvedPlace } from './geo/placeLookup';
import { PINNED_PLACE_REF } from './pinnedPeriod';
import { RESOLVE_PLACE_TOOL_NAME } from './placeTool';
import type { PlaceReader } from './timingPlaces';

/** The refs resolve_place handed out this turn, by ref, with the label the model saw. */
export type IssuedPlaceRefs = Map<string, string>;

/** The thread's place: the trip's (valid as the reserved "pinned" ref) or today's current place. */
interface BoundPlace {
  readonly label: string;
  /** True for a trip: its place also travels as the reserved "pinned" ref. */
  readonly pinned: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The reader every tool uses: an unissued ref reads the thread's place (or is unknown), never a city from the list. */
export function issuedPlaceReader(base: PlaceReader, issued: IssuedPlaceRefs, threadPlace?: ResolvedPlace): PlaceReader {
  return async (ref) => (issued.has(ref) ? base(ref) : threadPlace);
}

/** Said in a result whose invented place_ref read the thread's place. */
export function threadPlaceNote(label: string): string {
  return `used this thread's place (${label})`;
}

/** Every place_ref an argument object carries: the top-level one and each segment's. */
function refsIn(args: AgentJsonObject): string[] {
  const segments = Array.isArray(args.segments) ? args.segments : [];
  return [args.place_ref, ...segments.map((segment) => (record(segment) ? segment.place_ref : undefined))]
    .filter((ref) => ref !== undefined && ref !== null)
    .map(String);
}

function learn(issued: IssuedPlaceRefs, result: unknown): void {
  if (!record(result)) return;
  const ambiguous = result.status === 'ambiguous' && Array.isArray(result.candidates) ? result.candidates : [];
  const places = result.status === 'found' ? [result.place] : ambiguous;
  for (const place of places) {
    if (record(place) && typeof place.place_ref === 'string' && typeof place.label === 'string') issued.set(place.place_ref, place.label);
  }
}

function unissued(args: AgentJsonObject, issued: IssuedPlaceRefs, bound: BoundPlace | undefined): string | undefined {
  return refsIn(args).find((value) => !issued.has(value) && !(bound?.pinned && value === PINNED_PLACE_REF));
}

function explain(args: AgentJsonObject, issued: IssuedPlaceRefs, bound: BoundPlace | undefined, suffix: string): { readonly error: string } {
  const ref = unissued(args, issued, bound);
  const valid = [
    ...(bound?.pinned ? [`${PINNED_PLACE_REF} (this trip's place, ${bound.label})`] : []),
    ...[...issued].map(([value, label]) => `${value} (${label})`),
  ];
  return {
    error: `unknown place_ref${ref === undefined ? '' : ` "${ref}"`}: a place_ref must come from resolve_place in this turn. `
      + `Valid refs: ${valid.length > 0 ? valid.join(', ') : 'none yet'}. `
      + `Call resolve_place with the place the user named, or ask the user where.${suffix}`,
  };
}

/** Wrap one tool: resolve_place records the refs it hands out; any other tool's unknown-ref error lists the valid refs. */
function guard(tool: AgentTool, issued: IssuedPlaceRefs, bound: BoundPlace | undefined): AgentTool {
  if (tool.name === RESOLVE_PLACE_TOOL_NAME) {
    return { ...tool, execute: async (args, context) => {
      const result = await tool.execute(args, context);
      learn(issued, result);
      return result;
    } };
  }
  return { ...tool, execute: async (args, context) => {
    // Decided before the call: resolve_place may hand out more refs while it runs.
    const invented = bound !== undefined && unissued(args, issued, bound) !== undefined;
    const result = await tool.execute(args, context);
    if (!record(result)) return result;
    if (typeof result.error !== 'string') return invented && bound ? { ...result, place_note: threadPlaceNote(bound.label) } : result;
    if (!result.error.startsWith(PLACE_REF_ERROR)) return result;
    return explain(args, issued, bound, result.error.slice(PLACE_REF_ERROR.length));
  } };
}

/** Guard a turn's tools. `issued` is shared across the turn's rebuilds; `bound` is the thread's place. */
export function guardPlaceRefs(tools: readonly AgentTool[], issued: IssuedPlaceRefs, bound: BoundPlace | undefined): AgentTool[] {
  return tools.map((tool) => guard(tool, issued, bound));
}
