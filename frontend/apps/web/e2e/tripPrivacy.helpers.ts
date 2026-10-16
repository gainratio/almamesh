/**
 * What a time-travel trip may and may not send the model (contract 39d51337,
 * 2026-10-13). Every trip names its place's label and zone, the birth place
 * included. Never allowed in a request body: coordinates, the birth date or
 * time, birth_location_details field names, and any marker saying a place is
 * the birth place in the trip brief or a tool result. (The fixed system
 * privacy rules may mention the birth place as a concept, so the marker check
 * reads only the brief and the tool results.)
 */

interface WireMessage {
  readonly role?: string;
  readonly content?: string | null;
}

/** birth_location_details field names: the stored shape must never reach the model. */
export const BIRTH_FIELD_NAMES = /latitude|longitude|birth_location|location_name|timezone_offset/i;

/** Words that would tell the model a place is the birth place. */
export const BIRTH_PLACE_MARKER = /birth[ _-]?place|birthplace|place of birth/i;

/** The trip brief: the system prompt from its "PINNED PERIOD:" line on, or nothing. */
function tripBrief(system: string): string {
  const start = system.indexOf('PINNED PERIOD:');
  return start === -1 ? '' : system.slice(start);
}

/** Every birth-place marker in one request body's trip brief and tool results, with context. */
export function birthPlaceMarkers(body: string): string[] {
  let messages: readonly WireMessage[];
  try {
    messages = (JSON.parse(body) as { messages?: WireMessage[] }).messages ?? [];
  } catch {
    return [`unparseable body: ${body.slice(0, 80)}`];
  }
  const texts = messages.flatMap((message) => {
    if (message.role === 'tool') return [message.content ?? ''];
    if (message.role === 'system') return [tripBrief(message.content ?? '')];
    return [];
  });
  return texts.flatMap((text) => {
    const match = BIRTH_PLACE_MARKER.exec(text);
    return match ? [`${BIRTH_PLACE_MARKER} ~ ${text.slice(Math.max(0, match.index - 40), match.index + 40)}`] : [];
  });
}
