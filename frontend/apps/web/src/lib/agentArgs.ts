import type { AgentJsonObject } from '@almamesh/llm';

/** One string argument from a closed set, or a thrown error naming the set. */
export function enumArgument(args: AgentJsonObject, key: string, allowed: readonly string[]): string {
  const value = args[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}
