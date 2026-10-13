/**
 * The one shape check for a chat message's tool-call parts (chat store v4).
 * `appendMessage` and hydration use it to drop malformed parts and keep the
 * message; portable import uses it to refuse the backup and name the field.
 */

const MAX_PARTS = 32;
const MAX_PART_BYTES = 64 * 1024;
const MAX_PARTS_BYTES = 256 * 1024;
const MAX_TOOL_CALL_ID = 128;
const MAX_JSON_DEPTH = 64;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_KEYS = new Set(['type', 'text']);
const TOOL_CALL_KEYS = new Set(['type', 'toolCallId', 'toolName', 'args', 'result', 'status']);
const STATUSES: readonly unknown[] = ['complete', 'error'];

const encoder = new TextEncoder();

/** A plain object literal: no arrays, class instances, or exotic prototypes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** True when `value` survives JSON exactly: finite numbers, no undefined, bounded depth. */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function toolCallProblem(part: Record<string, unknown>, at: string): string | undefined {
  if (!onlyKeys(part, TOOL_CALL_KEYS)) return at;
  const { toolCallId, toolName, args, result, status } = part;
  if (typeof toolCallId !== 'string' || toolCallId.length < 1 || toolCallId.length > MAX_TOOL_CALL_ID) {
    return `${at}.toolCallId`;
  }
  if (typeof toolName !== 'string' || !TOOL_NAME.test(toolName)) return `${at}.toolName`;
  if (!isPlainObject(args) || !isJsonValue(args)) return `${at}.args`;
  if (result !== undefined && !isJsonValue(result)) return `${at}.result`;
  return STATUSES.includes(status) ? undefined : `${at}.status`;
}

function partProblem(part: unknown, at: string): string | undefined {
  if (!isPlainObject(part)) return at;
  if (part.type === 'tool-call') return toolCallProblem(part, at);
  if (part.type !== 'text') return `${at}.type`;
  if (!onlyKeys(part, TEXT_KEYS)) return at;
  return typeof part.text === 'string' ? undefined : `${at}.text`;
}

/**
 * The first problem with a message's `parts`, as a field path such as
 * `parts[2].toolName`, or `undefined` when every part is valid.
 */
export function chatMessagePartsProblem(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return 'parts';
  if (parts.length > MAX_PARTS) return 'parts.length';
  for (const [index, part] of parts.entries()) {
    const at = `parts[${index}]`;
    const problem = partProblem(part, at);
    if (problem) return problem;
    if (byteLength(part) > MAX_PART_BYTES) return `${at}.size`;
  }
  return byteLength(parts) > MAX_PARTS_BYTES ? 'parts.size' : undefined;
}
