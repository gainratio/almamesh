/**
 * Chrome's showSaveFilePicker needs transient user activation, which expires
 * about 5 s after the click. On a slow phone, building the backup (flush,
 * SQLite export, validation, PBKDF2) takes longer than that. This drives the
 * REAL file layer (backupFile.ts) with a picker that refuses after 5 s and an
 * export that takes 6 s: Export must still save.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { EMPTY_PORTABLE_REPAIR_REPORT } from '@almamesh/store';

import '../../../i18n/config';

vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  listSetAsideRecords: vi.fn(async () => []),
}));

vi.mock('../../../lib/backupService', () => ({
  buildBackupExport: vi.fn(),
  stageBackupImport: vi.fn(),
  commitBackupImport: vi.fn(),
  exportBackupFilename: () => 'almamesh-backup-slow.almamesh',
  safetyBackupFilename: (name: string) => name,
}));

import { buildBackupExport } from '../../../lib/backupService';
import { DataSettingsPanel } from '../DataSettings';

const written: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  written.length = 0;
  const clickedAt = Date.now();
  vi.stubGlobal(
    'showSaveFilePicker',
    vi.fn(async () => {
      if (Date.now() - clickedAt > 5_000) {
        throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
      }
      return {
        createWritable: async () => ({
          write: async (data: unknown) => void written.push(data),
          close: async () => undefined,
        }),
        getFile: async () => new File([], 'x'),
      };
    }),
  );
  vi.mocked(buildBackupExport).mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              filename: 'ignored.almamesh',
              content: new Uint8Array([9, 9]),
              repairs: EMPTY_PORTABLE_REPAIR_REPORT,
            }),
          6_000,
        );
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Export on a slow device (Chrome save picker, user activation)', () => {
  it('saves even when building the backup takes longer than the 5 s gesture window', async () => {
    render(<DataSettingsPanel />);
    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });

    fireEvent.click(screen.getByTestId('backup-export-button'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_500);
    });

    expect(screen.queryByTestId('backup-error')).toBeNull();
    expect(screen.getByTestId('backup-status').textContent).toContain('Backup');
    expect(written).toEqual([new Uint8Array([9, 9])]);
  });
});
