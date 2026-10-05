/**
 * Bounds for one canonical JSON row, enforced BEFORE `JSON.parse` allocates the
 * object graph. A single linear scan over the text counts values, nesting depth,
 * entries per container and raw string length, so a hostile or oversized row is
 * refused at the cost of reading its characters once, not of materializing it.
 *
 * The limits are sized from measurement, not guessed: one row costs ~64 MB of
 * Chromium JS heap per 1,000,000 nodes through decode + validate + repair
 * (2026-10-05, CDP Runtime.getHeapUsage), so 1,000,000 nodes keeps one row near
 * 64 MB on a low-end phone while holding ~200,000 chat messages.
 */

export const MAX_JSON_NODES = 1_000_000;
export const MAX_JSON_DEPTH = 64;
export const MAX_COLLECTION_ENTRIES = 250_000;
export const MAX_STRING_CHARACTERS = 1_000_000;
/** A JSON escape spells one character with at most 6 raw characters (`\uXXXX`). */
const MAX_RAW_STRING_CHARACTERS = MAX_STRING_CHARACTERS * 6;

export class JsonBoundsError extends Error {
  public override readonly name = 'JsonBoundsError';
}

interface Frame {
  readonly object: boolean;
  entries: number;
}

interface Scan {
  nodes: number;
  readonly stack: Frame[];
  /** True where the next token starts a value (not an object key). */
  expectingValue: boolean;
}

function refuse(row: string, what: string): never {
  throw new JsonBoundsError(`Portable state row "${row}" ${what}.`);
}

function startValue(scan: Scan, row: string): void {
  if (!scan.expectingValue) return;
  scan.expectingValue = false;
  scan.nodes += 1;
  if (scan.nodes > MAX_JSON_NODES) refuse(row, `exceeds ${MAX_JSON_NODES} JSON nodes`);
  const frame = scan.stack.at(-1);
  if (frame === undefined) return;
  frame.entries += 1;
  if (frame.entries > MAX_COLLECTION_ENTRIES) {
    refuse(row, `contains a collection with more than ${MAX_COLLECTION_ENTRIES} entries`);
  }
}

/** Skip one string starting at `start` (a quote); returns the index after it. */
function skipString(text: string, start: number, row: string): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }
  if (index - start - 1 > MAX_RAW_STRING_CHARACTERS) {
    refuse(row, `string exceeds ${MAX_STRING_CHARACTERS} characters`);
  }
  return index + 1;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/**
 * Refuse a row whose JSON would exceed the node, depth, entry or string bounds,
 * without parsing it. Object keys are not values, so they are not counted (the
 * same rule as the post-parse validator). Malformed JSON is left to JSON.parse.
 */
export function assertJsonTextWithinBounds(text: string, row: string): void {
  const scan: Scan = { nodes: 0, stack: [], expectingValue: true };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      startValue(scan, row); // a key leaves expectingValue false: not counted
      index = skipString(text, index, row);
      continue;
    }
    if (char === '{' || char === '[') {
      startValue(scan, row);
      scan.stack.push({ object: char === '{', entries: 0 });
      if (scan.stack.length > MAX_JSON_DEPTH) refuse(row, `exceeds JSON depth ${MAX_JSON_DEPTH}`);
      scan.expectingValue = char === '[';
    } else if (char === '}' || char === ']') {
      scan.stack.pop();
      scan.expectingValue = false;
    } else if (char === ',') {
      scan.expectingValue = scan.stack.at(-1)?.object !== true;
    } else if (char === ':') {
      scan.expectingValue = true;
    } else if (!isWhitespace(char)) {
      startValue(scan, row);
    }
    index += 1;
  }
}
