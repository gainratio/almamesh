function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A completed tool call's result as the provider was sent it (chat tool layer redesign,
 * 2026-10-14: the tool's own JSON value, no {ok, value} envelope). Throws unless it is a
 * readable object with no `error` and not an unavailable reading.
 */
export function parseCompletedToolResult(content: string | null | undefined): Record<string, unknown> {
  const result: unknown = JSON.parse(content ?? 'null');
  if (!isRecord(result) || 'error' in result || result.available === false) {
    throw new Error('Expected a completed tool result: an object with no error.');
  }
  return result;
}
