import { describe, expect, it } from 'vitest';

import type { ChatMessagePart } from '@almamesh/shared-types';

import { chatMessagePartsProblem } from './chatParts';

const TOOL_CALL: ChatMessagePart = {
  type: 'tool-call',
  toolCallId: 'call_1',
  toolName: 'get_transits',
  args: { place: 'Singapore', month: '2019-05' },
  result: { saturn: 'Sagittarius', retrograde: true, dates: ['2019-05-01'], none: null },
  status: 'complete',
};

const KIB = 1024;

/** A text part whose JSON is exactly `bytes` long. */
function textPartOfBytes(bytes: number): ChatMessagePart {
  const overhead = JSON.stringify({ type: 'text', text: '' }).length;
  return { type: 'text', text: 'x'.repeat(bytes - overhead) };
}

describe('chatMessagePartsProblem', () => {
  it('accepts ordered text and tool-call parts', () => {
    expect(chatMessagePartsProblem([{ type: 'text', text: 'Saturn returns.' }, TOOL_CALL])).toBeUndefined();
  });

  it('accepts a tool call with no result yet and an error status', () => {
    const { result: _result, ...pending } = TOOL_CALL as Extract<ChatMessagePart, { type: 'tool-call' }>;
    expect(chatMessagePartsProblem([{ ...pending, status: 'error' }])).toBeUndefined();
  });

  it('accepts a skipped status: a call answered without running is not an error', () => {
    expect(chatMessagePartsProblem([{ ...TOOL_CALL, status: 'skipped', result: { code: 'skipped' } }])).toBeUndefined();
  });

  it('refuses anything that is not an array', () => {
    expect(chatMessagePartsProblem({ 0: TOOL_CALL })).toBe('parts');
    expect(chatMessagePartsProblem(null)).toBe('parts');
  });

  it('allows 32 parts and refuses 33', () => {
    const part: ChatMessagePart = { type: 'text', text: 'a' };
    expect(chatMessagePartsProblem(Array.from({ length: 32 }, () => part))).toBeUndefined();
    expect(chatMessagePartsProblem(Array.from({ length: 33 }, () => part))).toBe('parts.length');
  });

  it.each([
    ['an unknown type', { type: 'image', url: 'x' }, 'parts[0].type'],
    ['a non-object part', 'text', 'parts[0]'],
    ['an extra key on a text part', { type: 'text', text: 'a', html: '<b>' }, 'parts[0]'],
    ['a non-string text', { type: 'text', text: 3 }, 'parts[0].text'],
    ['an extra key on a tool call', { ...TOOL_CALL, latitude: 1.3 }, 'parts[0]'],
    ['an empty toolCallId', { ...TOOL_CALL, toolCallId: '' }, 'parts[0].toolCallId'],
    ['a 129-character toolCallId', { ...TOOL_CALL, toolCallId: 'c'.repeat(129) }, 'parts[0].toolCallId'],
    ['a toolName with a space', { ...TOOL_CALL, toolName: 'get transits' }, 'parts[0].toolName'],
    ['a 65-character toolName', { ...TOOL_CALL, toolName: 't'.repeat(65) }, 'parts[0].toolName'],
    ['args that are an array', { ...TOOL_CALL, args: ['Singapore'] }, 'parts[0].args'],
    ['args holding NaN', { ...TOOL_CALL, args: { n: Number.NaN } }, 'parts[0].args'],
    ['args holding undefined', { ...TOOL_CALL, args: { n: undefined } }, 'parts[0].args'],
    ['args that are a Date', { ...TOOL_CALL, args: new Date(0) }, 'parts[0].args'],
    ['a result holding Infinity', { ...TOOL_CALL, result: [Infinity] }, 'parts[0].result'],
    ['a result holding a function', { ...TOOL_CALL, result: { f: () => 1 } }, 'parts[0].result'],
    ['a running status', { ...TOOL_CALL, status: 'running' }, 'parts[0].status'],
  ])('refuses %s, naming the field', (_label, part, field) => {
    expect(chatMessagePartsProblem([part])).toBe(field);
  });

  it('accepts a 128-character toolCallId and a 64-character toolName', () => {
    expect(
      chatMessagePartsProblem([{ ...TOOL_CALL, toolCallId: 'c'.repeat(128), toolName: 't'.repeat(64) }]),
    ).toBeUndefined();
  });

  it('refuses a result nested too deep to walk safely', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 100; i += 1) deep = [deep];
    expect(chatMessagePartsProblem([{ ...TOOL_CALL, result: deep }])).toBe('parts[0].result');
  });

  it('allows a part of exactly 64 KiB and refuses one byte more', () => {
    expect(chatMessagePartsProblem([textPartOfBytes(64 * KIB)])).toBeUndefined();
    expect(chatMessagePartsProblem([textPartOfBytes(64 * KIB + 1)])).toBe('parts[0].size');
  });

  it('measures size in UTF-8 bytes, not characters', () => {
    const overhead = JSON.stringify({ type: 'text', text: '' }).length;
    // "ä" is 2 UTF-8 bytes: half as many characters already pass 64 KiB.
    const text = 'ä'.repeat(Math.ceil((64 * KIB - overhead) / 2));
    expect(chatMessagePartsProblem([{ type: 'text', text }])).toBe('parts[0].size');
  });

  it('allows a whole array of exactly 256 KiB and refuses one byte more', () => {
    // A JSON array of four parts adds 2 bracket bytes and 3 commas.
    const four = (last: number) => [
      textPartOfBytes(64 * KIB),
      textPartOfBytes(64 * KIB),
      textPartOfBytes(64 * KIB),
      textPartOfBytes(last),
    ];
    expect(chatMessagePartsProblem(four(64 * KIB - 5))).toBeUndefined();
    expect(chatMessagePartsProblem(four(64 * KIB - 4))).toBe('parts.size');
  });
});
