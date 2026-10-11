function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Require a successful wire envelope before exposing its local tool value. */
export function parseSuccessfulToolResult(content: string | null | undefined): Record<string, unknown> {
  const result: unknown = JSON.parse(content ?? 'null');
  if (!isRecord(result) || result.ok !== true || 'error' in result
    || !isRecord(result.value) || 'error' in result.value) {
    throw new Error('Expected a successful local tool envelope with an object value and no error.');
  }
  return result.value;
}
