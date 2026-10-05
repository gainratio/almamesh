import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertJsonTextWithinBounds,
  JsonBoundsError,
  MAX_COLLECTION_ENTRIES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_STRING_CHARACTERS,
} from './jsonBounds';

const ROW = 'almamesh-chat-history';
const array = (count: number, item = '0') => `[${Array.from({ length: count }, () => item).join(',')}]`;

afterEach(() => vi.restoreAllMocks());

describe('assertJsonTextWithinBounds (before JSON.parse)', () => {
  it('pins the documented limits', () => {
    expect([MAX_JSON_NODES, MAX_JSON_DEPTH, MAX_COLLECTION_ENTRIES, MAX_STRING_CHARACTERS]).toEqual([
      1_000_000, 64, 250_000, 1_000_000,
    ]);
  });

  it('refuses a row over the node limit without ever calling JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    // 5 arrays of 200,000 entries: 1,000,006 values, each array under the entry limit.
    const text = `{"a":${array(200_000)},"b":${array(200_000)},"c":${array(200_000)},"d":${array(200_000)},"e":${array(200_000)}}`;

    expect(() => assertJsonTextWithinBounds(text, ROW)).toThrow(JsonBoundsError);
    expect(() => assertJsonTextWithinBounds(text, ROW)).toThrow(/exceeds 1000000 JSON nodes/);
    expect(parse).not.toHaveBeenCalled();
  });

  it('counts values exactly like the post-parse validator: the limit itself passes', () => {
    // Root object + 4 arrays (5 nodes) + 999,995 numbers = 1,000,000.
    const text = `{"a":${array(249_999)},"b":${array(249_999)},"c":${array(249_999)},"d":${array(249_998)}}`;
    expect(() => assertJsonTextWithinBounds(text, ROW)).not.toThrow();
  });

  it('does not count object keys, or commas and colons inside strings', () => {
    const tricky = JSON.stringify({ 'k,:{[': 'v,"[{]}', nested: { a: ['x', '\\"]'] } });
    // values: root, 'v...', nested, array, 'x', '\\"]' = 6 nodes
    expect(() => assertJsonTextWithinBounds(tricky, ROW)).not.toThrow();
    const keys = `{${Array.from({ length: 300_000 }, (_, i) => `"k${i}":0`).join(',')}}`;
    expect(() => assertJsonTextWithinBounds(keys, ROW)).toThrow(/more than 250000 entries/);
  });

  it('refuses a collection over the entry limit before parsing', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => assertJsonTextWithinBounds(array(MAX_COLLECTION_ENTRIES + 1), ROW)).toThrow(/more than 250000 entries/);
    expect(() => assertJsonTextWithinBounds(array(MAX_COLLECTION_ENTRIES), ROW)).not.toThrow();
    expect(parse).not.toHaveBeenCalled();
  });

  it('refuses nesting deeper than the limit before parsing', () => {
    const deep = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
    expect(() => assertJsonTextWithinBounds(deep(MAX_JSON_DEPTH + 1), ROW)).toThrow(/exceeds JSON depth 64/);
    expect(() => assertJsonTextWithinBounds(deep(MAX_JSON_DEPTH), ROW)).not.toThrow();
  });

  it('refuses a raw string too long to be within the character limit even if every character were escaped', () => {
    const huge = `"${'x'.repeat(MAX_STRING_CHARACTERS * 6 + 1)}"`;
    expect(() => assertJsonTextWithinBounds(huge, ROW)).toThrow(/string exceeds 1000000 characters/);
  });
});
