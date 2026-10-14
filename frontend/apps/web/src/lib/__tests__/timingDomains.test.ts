import { describe, expect, it } from 'vitest';

import { domainsPayload, hoistSharedStrengthNote } from '../timingDomains';

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

// 2026-10-14: the obstacles domain made 8 life areas and its Mars windows took the heaviest
// committed read to 9259 chars, over the 8192 cap. A window's descriptor already names its
// source, trigger and kind ("obstacles.transit.mars.ingress.gemini"), so those fields go.
describe('domainsPayload', () => {
  const window = { month: '2025-01', source: 'transit', kind: 'sign_ingress', trigger: 'mars', severity: 'neutral', descriptor: 'obstacles.transit.mars.ingress.gemini' };

  it('keeps each window as its month, severity and descriptor, and hoists the shared note', () => {
    const result = domainsPayload([{ ...row('obstacles', 'same'), windows: [window] }, { ...row('career', 'same'), windows: [] }]);
    expect(result).toEqual({
      data: [
        { domain: 'obstacles', band: 'moderate', windows: [{ month: '2025-01', severity: 'neutral', descriptor: 'obstacles.transit.mars.ingress.gemini' }] },
        { domain: 'career', band: 'moderate', windows: [] },
      ],
      notes: ['same'],
    });
  });

  it('leaves an unavailable section as it is', () => {
    expect(domainsPayload({ available: false })).toEqual({ data: { available: false }, notes: [] });
  });
});
