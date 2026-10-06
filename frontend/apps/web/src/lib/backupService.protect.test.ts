/**
 * "Is there anything on this browser a restore could destroy?"
 *
 * The pre-import safety copy exists so Replace is undoable. On a browser that
 * has never held AlmaMesh data there is nothing to undo, and forcing a new user
 * to download an empty "safety" file (and, without a save picker, to confirm it
 * appeared) is pure friction on the "move to a new phone" path. These tests pin
 * the decision rule: the copy is skipped ONLY when no person, chart, record,
 * chat, set-aside or quarantined row, and no saved setting exists. Anything
 * else counts as data to protect.
 */
import { describe, expect, it } from 'vitest';

import { hasDataToProtect, holdsDataToProtect, type ProtectableState } from './backupService';

function row(state: unknown, version = 1): string {
  return JSON.stringify({ state, version });
}

/** What a never-used browser holds after its first boot: empty store rows only. */
function freshRows(): Map<string, string> {
  return new Map([
    ['almamesh-profiles', row({ profiles: {}, activeProfileId: null })],
    ['almamesh-chart-library', row({ charts: {} })],
    ['almamesh-life-events', row({ eventsByProfile: {} }, 4)],
    ['almamesh-rectification-records', row({ recordsByProfile: {} }, 2)],
    ['almamesh-chat-history', row({ threads: {}, messages: {}, summaries: {} }, 2)],
    ['almamesh-interpretations', row({ byChart: {} }, 6)],
    ['almamesh-mesh-readings', row({ byPair: {} })],
    ['almamesh-predictive', row({ status: 'idle' }, 3)],
    ['almamesh-language', row({ language: 'es' })],
    ['almamesh-preferences', JSON.stringify({ version: 1, values: {} })],
    ['almamesh-deletion-tombstones', JSON.stringify({ version: 1, activeEpoch: 0 })],
  ]);
}

function state(values: Map<string, string>, extra: Partial<ProtectableState> = {}): ProtectableState {
  return { values, quarantine: new Map(), setAsideCount: 0, ...extra };
}

describe('holdsDataToProtect', () => {
  it('a never-used browser (empty rows, a language choice) holds nothing to protect', () => {
    expect(holdsDataToProtect(state(freshRows()))).toBe(false);
  });

  it('a browser with no rows at all holds nothing to protect', () => {
    expect(holdsDataToProtect(state(new Map()))).toBe(false);
  });

  it('one saved person is data to protect', () => {
    const values = freshRows();
    values.set(
      'almamesh-profiles',
      row({ profiles: { p1: { id: 'p1', name: 'Synthetic' } }, activeProfileId: 'p1' }),
    );
    expect(holdsDataToProtect(state(values))).toBe(true);
  });

  it('a chat with no person is still data to protect', () => {
    const values = freshRows();
    values.set('almamesh-chat-history', row({ threads: { t1: { id: 't1' } }, messages: {}, summaries: {} }, 2));
    expect(holdsDataToProtect(state(values))).toBe(true);
  });

  it('a finished predictive result is data to protect', () => {
    const values = freshRows();
    values.set('almamesh-predictive', row({ status: 'ready', transitCtx: { x: 1 } }, 3));
    expect(holdsDataToProtect(state(values))).toBe(true);
  });

  it('a saved setting (the AI key lives here) is data to protect', () => {
    const values = freshRows();
    values.set(
      'almamesh-preferences',
      JSON.stringify({ version: 1, values: { 'almamesh-llm-settings': '{"apiKey":"sk-synthetic"}' } }),
    );
    expect(holdsDataToProtect(state(values))).toBe(true);
  });

  it('set-aside records are data to protect', () => {
    expect(holdsDataToProtect(state(freshRows(), { setAsideCount: 1 }))).toBe(true);
  });

  it('quarantined rows are data to protect', () => {
    expect(
      holdsDataToProtect(state(freshRows(), { quarantine: new Map([['q', '{}']]) })),
    ).toBe(true);
  });

  it('an unreadable row is treated as data to protect, never as empty', () => {
    const values = freshRows();
    values.set('almamesh-chart-library', '{not json');
    expect(holdsDataToProtect(state(values))).toBe(true);
  });

  it('an unreadable preferences row is treated as data to protect', () => {
    const values = freshRows();
    values.set('almamesh-preferences', 'nope');
    expect(holdsDataToProtect(state(values))).toBe(true);
  });
});

describe('hasDataToProtect', () => {
  it('reads the live state through the injected reader', async () => {
    await expect(hasDataToProtect(async () => state(freshRows()))).resolves.toBe(false);
    await expect(
      hasDataToProtect(async () => state(freshRows(), { setAsideCount: 2 })),
    ).resolves.toBe(true);
  });

  it('when the state cannot be read, it assumes there is data to protect', async () => {
    await expect(
      hasDataToProtect(async () => {
        throw new Error('storage busy');
      }),
    ).resolves.toBe(true);
  });
});
