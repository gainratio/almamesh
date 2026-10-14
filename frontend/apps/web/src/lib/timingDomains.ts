/**
 * The life-area read on `get_timing`, kept under the agent's tool-result cap
 * (AGENT_LIMITS.maxResultChars). Every life area carries the same strength-method
 * note; repeated seven times it is about 1 KB of a payload that can otherwise go
 * over the cap. Said once, as a note, the model reads the same thing.
 */
import type { SanitizedDomainForecast, SanitizedDomainWindow } from '@almamesh/llm';

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

/** A window's descriptor already names its source, trigger and kind ("obstacles.transit.mars.ingress.gemini"). */
function briefWindows(forecast: SanitizedDomainForecast): Omit<SanitizedDomainForecast, 'windows'> & { readonly windows: readonly Pick<SanitizedDomainWindow, 'month' | 'severity' | 'descriptor'>[] } {
  if (!Array.isArray(forecast.windows)) return forecast;
  return { ...forecast, windows: forecast.windows.map(({ month, severity, descriptor }) => ({ month, severity, descriptor })) };
}

/**
 * The life-area read get_timing returns: each window as its month, severity and
 * descriptor, and the shared strength note said once. Eight life areas with the
 * obstacles Mars windows went over the cap with the window's repeated fields.
 */
export function domainsPayload(data: unknown): DomainsPayload {
  return hoistSharedStrengthNote(isForecastList(data) ? data.map(briefWindows) : data);
}
