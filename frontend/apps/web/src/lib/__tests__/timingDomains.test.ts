import { describe, expect, it } from 'vitest';

import { hoistSharedStrengthNote } from '../timingDomains';

const row = (domain: string, strength_note: string) => ({ domain, band: 'moderate', strength_note });

describe('hoistSharedStrengthNote', () => {
  it('lifts a note every life area shares into one note', () => {
    const result = hoistSharedStrengthNote([row('career', 'same'), row('health', 'same')]);
    expect(result).toEqual({
      data: [
        { domain: 'career', band: 'moderate' },
        { domain: 'health', band: 'moderate' },
      ],
      notes: ['same'],
    });
  });

  it('keeps per-area notes when they differ', () => {
    const data = [row('career', 'one'), row('health', 'two')];
    expect(hoistSharedStrengthNote(data)).toEqual({ data, notes: [] });
  });

  it('leaves an empty list, an unavailable section and a missing note as they are', () => {
    expect(hoistSharedStrengthNote([])).toEqual({ data: [], notes: [] });
    const unavailable = { available: false };
    expect(hoistSharedStrengthNote(unavailable)).toEqual({ data: unavailable, notes: [] });
    const noNote = [row('career', '')];
    expect(hoistSharedStrengthNote(noNote)).toEqual({ data: noNote, notes: [] });
  });
});
