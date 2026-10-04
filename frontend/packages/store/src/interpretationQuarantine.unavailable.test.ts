/**
 * Northstar review of #240: when SQLite cannot be opened at all (no OPFS
 * SQLite and not a Node test runtime), holding an unreadable interpretation
 * must report "not held" AND log a typed diagnostic, never fail silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sqlite = vi.hoisted(() => ({ unavailable: false }));

vi.mock('./portableState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portableState')>();
  return {
    ...actual,
    resolvePortableStateMode: (...args: Parameters<typeof actual.resolvePortableStateMode>) => {
      if (sqlite.unavailable) throw new actual.PortableStateUnavailableError();
      return actual.resolvePortableStateMode(...args);
    },
  };
});

const { quarantineUnreadableInterpretation } = await import('./interpretation');

afterEach(() => {
  sqlite.unavailable = false;
  vi.restoreAllMocks();
});

describe('holding an unreadable interpretation when SQLite cannot open', () => {
  it('reports it as not held and logs a typed hold failure', async () => {
    sqlite.unavailable = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const held = await quarantineUnreadableInterpretation({ source: 'canonical-sqlite', raw: 'z' });

    expect(held).toBe(false);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      '[almamesh:warn:storage.interpretation_quarantine_hold_failed]',
    );
  });
});
