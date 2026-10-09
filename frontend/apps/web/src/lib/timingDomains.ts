/**
 * The life-area read on `get_timing`, kept under the agent's tool-result cap
 * (AGENT_LIMITS.maxResultChars). Every life area carries the same strength-method
 * note; repeated seven times it is about 1 KB of a payload that can otherwise go
 * over the cap. Said once, as a note, the model reads the same thing.
 */
import type { SanitizedDomainForecast } from '@almamesh/llm';

export interface DomainsPayload {
  readonly data: unknown;
  readonly notes: readonly string[];
}

function isForecastList(data: unknown): data is readonly SanitizedDomainForecast[] {
  return Array.isArray(data);
}

/** Lift a strength note every life area shares into one note; leave anything else as it is. */
export function hoistSharedStrengthNote(data: unknown): DomainsPayload {
  if (!isForecastList(data)) return { data, notes: [] };
  const note = data[0]?.strength_note;
  if (!note || data.some((forecast) => forecast.strength_note !== note)) return { data, notes: [] };
  return { data: data.map(({ strength_note: _shared, ...rest }) => rest), notes: [note] };
}
