/**
 * Tests for the pure browser file-I/O helper behind Backup & Restore (Spec 061).
 *
 * This module owns NO astrology, NO store, and NO crypto — it only:
 *  - saves JSON text or SQLite bytes to a file the user chooses
 *    with a graceful `<a download>` fallback for Firefox/Safari, and
 *  - reads JSON text or SQLite bytes back, with an `<input type=file>`
 *    fallback.
 *
 * happy-dom provides DOMException, URL.createObjectURL/revokeObjectURL, Blob and
 * File.arrayBuffer(), and exposes `window === globalThis` — so `vi.stubGlobal` (the
 * project convention, see submitFeedback.test.ts) makes `window.showSaveFilePicker`
 * / `window.showOpenFilePicker` present, and deleting the stub restores the
 * fallback path. All fixtures are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_BACKUP_FILE_BYTES,
  openBackupSaveTarget,
  pickBackupFile,
  saveBackupFile,
} from './backupFile';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A DOMException that mirrors what a picker throws when the user cancels. */
function abortError(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError');
}

// A minimal fake `<input type=file>` so the fallback path can be driven without
// fighting happy-dom's read-only `files` getter: clicking fires exactly one
// registered event, and `files` reflects the (optional) selected file.
interface FakeFileInput {
  type: string;
  accept: string;
  files: File[];
  addEventListener(name: string, cb: () => void): void;
  click(): void;
}

function makeFakeFileInput(config: {
  file: File | null;
  event: 'change' | 'cancel';
}): FakeFileInput {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    type: '',
    accept: '',
    files: config.file ? [config.file] : [],
    addEventListener(name, cb) {
      (handlers[name] ??= []).push(cb);
    },
    click() {
      for (const cb of handlers[config.event] ?? []) cb();
    },
  };
}

describe('saveBackupFile', () => {
  it('writes text through the File System Access picker and closes it', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);

    const result = await saveBackupFile('almamesh-backup.json', 'PAYLOAD');

    expect(result).toBe('saved');
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'almamesh-backup.json' }),
    );
    expect(write).toHaveBeenCalledWith('PAYLOAD');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes SQLite bytes without text or base64 conversion', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    const bytes = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 0xff]);

    await expect(saveBackupFile('almamesh.sqlite3', bytes)).resolves.toBe('saved');

    expect(write).toHaveBeenCalledWith(bytes);
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        types: [expect.objectContaining({ accept: { 'application/vnd.sqlite3': expect.any(Array) } })],
      }),
    );
  });

  it('writes encrypted .almamesh bytes with the dedicated file type', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close: vi.fn() }),
    });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    const bytes = new Uint8Array([...new TextEncoder().encode('ALMAMESH'), 3, 0xff]);

    await saveBackupFile('almamesh-backup-2026-07-01T12-34-56-000Z.almamesh', bytes);

    expect(write).toHaveBeenCalledWith(bytes);
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      types: [expect.objectContaining({
        accept: { 'application/vnd.almamesh.backup': ['.almamesh'] },
      })],
    }));
  });

  it('returns "cancelled" (no throw) when the picker is aborted', async () => {
    const showSaveFilePicker = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);

    await expect(saveBackupFile('backup.json', 'PAYLOAD')).resolves.toBe('cancelled');
  });

  it('propagates non-abort picker errors', async () => {
    const showSaveFilePicker = vi.fn().mockRejectedValue(new Error('disk full'));
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);

    await expect(saveBackupFile('backup.json', 'PAYLOAD')).rejects.toThrow('disk full');
  });

  it('falls back to an <a download> when the File System Access API is absent', async () => {
    vi.useFakeTimers();
    // No showSaveFilePicker stub → the fallback download path runs.
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const realCreateElement = document.createElement.bind(document);
    const clickSpy = vi.fn();
    let anchor: HTMLAnchorElement | undefined;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'a') {
        anchor = el as HTMLAnchorElement;
        (el as HTMLAnchorElement).click = clickSpy;
      }
      return el;
    }) as unknown as typeof document.createElement);

    const result = await saveBackupFile('almamesh-backup-2026-07-01.json', 'PAYLOAD');

    // An anchor click starts a download, but the browser offers no completion
    // signal. Callers performing a destructive restore must ask the user to
    // confirm the safety file actually appeared before proceeding.
    expect(result).toBe('unverified');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor?.download).toBe('almamesh-backup-2026-07-01.json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    vi.useRealTimers();
  });

  it('preserves SQLite bytes and MIME type in the download fallback', async () => {
    vi.useFakeTimers();
    let captured: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      captured = blob as Blob;
      return 'blob:sqlite';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = realCreateElement(tag);
      if (tag === 'a') (element as HTMLAnchorElement).click = vi.fn();
      return element;
    }) as unknown as typeof document.createElement);
    const bytes = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 0xff]);

    await saveBackupFile('backup.sqlite3', bytes);

    expect(captured?.type).toBe('application/vnd.sqlite3');
    expect([...new Uint8Array(await captured!.arrayBuffer())]).toEqual([...bytes]);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });
});

/** Chrome's showSaveFilePicker needs transient user activation (~5 s after the click). */
function gestureBoundPicker(clickAt: number) {
  const written: unknown[] = [];
  const picker = vi.fn(async () => {
    if (Date.now() - clickAt > 5_000) {
      throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
    }
    return {
      createWritable: async () => ({
        write: async (data: unknown) => void written.push(data),
        close: async () => undefined,
      }),
      getFile: async () => new File([], 'x'),
      remove: vi.fn(async () => undefined),
    };
  });
  return { picker, written };
}

describe('openBackupSaveTarget (picker first, inside the click)', () => {
  it('opens the save picker at once, so a 6 s export still saves', async () => {
    vi.useFakeTimers();
    const { picker, written } = gestureBoundPicker(Date.now());
    vi.stubGlobal('showSaveFilePicker', picker);

    const target = openBackupSaveTarget('almamesh-backup-x.almamesh');
    expect(picker).toHaveBeenCalledTimes(1); // synchronously, inside the gesture
    expect(await target.choice).toBe('chosen');
    await vi.advanceTimersByTimeAsync(6_000); // flush + SQLite export + PBKDF2 on a slow phone
    await expect(target.write(new Uint8Array([7]))).resolves.toBe('saved');

    expect(written).toEqual([new Uint8Array([7])]);
    expect(picker.mock.calls[0]).toEqual([
      expect.objectContaining({
        suggestedName: 'almamesh-backup-x.almamesh',
        types: [expect.objectContaining({ accept: { 'application/vnd.almamesh.backup': ['.almamesh'] } })],
      }),
    ]);
    vi.useRealTimers();
  });

  it('(the old order) a picker opened after a 6 s export loses the gesture', async () => {
    vi.useFakeTimers();
    const { picker } = gestureBoundPicker(Date.now());
    vi.stubGlobal('showSaveFilePicker', picker);

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(saveBackupFile('almamesh-backup-x.almamesh', new Uint8Array([7]))).rejects.toMatchObject({
      name: 'SecurityError',
    });
    vi.useRealTimers();
  });

  it('reports a dismissed picker as cancelled before any export work', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockRejectedValue(abortError()));

    await expect(openBackupSaveTarget('a.almamesh').choice).resolves.toBe('cancelled');
  });

  it('removes the empty file the picker created when nothing will be written', async () => {
    const { picker } = gestureBoundPicker(Date.now());
    vi.stubGlobal('showSaveFilePicker', picker);

    const target = openBackupSaveTarget('a.almamesh');
    await target.choice;
    await target.discard();

    const handle = await picker.mock.results[0]!.value;
    expect(handle.remove).toHaveBeenCalledTimes(1);
  });

  it('falls back to a download (unverified) where the picker does not exist', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = realCreateElement(tag);
      if (tag === 'a') (element as HTMLAnchorElement).click = vi.fn();
      return element;
    }) as unknown as typeof document.createElement);

    const target = openBackupSaveTarget('a.almamesh');

    await expect(target.choice).resolves.toBe('chosen');
    await expect(target.write(new Uint8Array([1]))).resolves.toBe('unverified');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('keeps the download Blob URL alive for 40 s (WebKit reads it late)', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = realCreateElement(tag);
      if (tag === 'a') (element as HTMLAnchorElement).click = vi.fn();
      return element;
    }) as unknown as typeof document.createElement);

    await saveBackupFile('a.almamesh', new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(39_999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledWith('blob:late');
    vi.useRealTimers();
  });
});

describe('pickBackupFile', () => {
  it('rejects an oversized file before reading it into memory', async () => {
    const arrayBuffer = vi.fn();
    const file = {
      name: 'huge.almamesh',
      type: 'application/vnd.almamesh.backup',
      size: MAX_BACKUP_FILE_BYTES + 1,
      arrayBuffer,
    } as unknown as File;
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([
      { getFile: vi.fn().mockResolvedValue(file) },
    ]));

    await expect(pickBackupFile()).rejects.toThrow('too large');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads the text of the picked file via the File System Access API', async () => {
    const file = new File(['HELLO'], 'backup.json', { type: 'application/json' });
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    await expect(pickBackupFile()).resolves.toBe('HELLO');
    expect(showOpenFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false }),
    );
  });

  it('returns SQLite bytes byte-for-byte via the File System Access API', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 0x00, 0xff]);
    const file = new File([bytes], 'backup.sqlite3', { type: 'application/vnd.sqlite3' });
    const showOpenFilePicker = vi.fn().mockResolvedValue([
      { getFile: vi.fn().mockResolvedValue(file) },
    ]);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    const picked = await pickBackupFile();

    expect(picked).toBeInstanceOf(Uint8Array);
    expect([...(picked as Uint8Array)]).toEqual([...bytes]);
  });

  it('returns an encrypted .almamesh file as binary and offers it in the picker', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('ALMAMESH'), 3, 0xff]);
    const file = new File([bytes], 'backup.almamesh', { type: 'application/vnd.almamesh.backup' });
    const showOpenFilePicker = vi.fn().mockResolvedValue([
      { getFile: vi.fn().mockResolvedValue(file) },
    ]);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    const picked = await pickBackupFile();

    expect([...(picked as Uint8Array)]).toEqual([...bytes]);
    expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      types: expect.arrayContaining([
        expect.objectContaining({ accept: { 'application/vnd.almamesh.backup': ['.almamesh'] } }),
      ]),
    }));
  });

  it('keeps unknown binary as bytes instead of decoding it as JSON', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x41]);
    const file = new File([bytes], 'not-a-backup.bin');
    const showOpenFilePicker = vi.fn().mockResolvedValue([
      { getFile: vi.fn().mockResolvedValue(file) },
    ]);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    const picked = await pickBackupFile();
    expect(picked).toBeInstanceOf(Uint8Array);
    expect([...(picked as Uint8Array)]).toEqual([...bytes]);
  });

  it('returns null when the open picker is aborted', async () => {
    const showOpenFilePicker = vi.fn().mockRejectedValue(abortError());
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    await expect(pickBackupFile()).resolves.toBeNull();
  });

  it('reads the chosen file via an <input> fallback when the API is absent', async () => {
    const file = new File(['CONTENT'], 'backup.json', { type: 'application/json' });
    const fakeInput = makeFakeFileInput({ file, event: 'change' });
    vi.spyOn(document, 'createElement').mockReturnValue(
      fakeInput as unknown as HTMLElement,
    );

    await expect(pickBackupFile()).resolves.toBe('CONTENT');
    expect(fakeInput.type).toBe('file');
    expect(fakeInput.accept).toContain('.json');
  });

  it('resolves null from the <input> fallback when nothing is selected', async () => {
    const fakeInput = makeFakeFileInput({ file: null, event: 'change' });
    vi.spyOn(document, 'createElement').mockReturnValue(
      fakeInput as unknown as HTMLElement,
    );

    await expect(pickBackupFile()).resolves.toBeNull();
  });

  it('resolves null from the <input> fallback when the dialog is cancelled', async () => {
    const fakeInput = makeFakeFileInput({ file: null, event: 'cancel' });
    vi.spyOn(document, 'createElement').mockReturnValue(
      fakeInput as unknown as HTMLElement,
    );

    await expect(pickBackupFile()).resolves.toBeNull();
  });

  // ITEM 5c — some browsers never fire `cancel`; the only signal that the dialog
  // closed with no selection is the window regaining focus. Resolve null then.
  it('resolves null from the <input> fallback when the window refocuses without a change', async () => {
    vi.useFakeTimers();
    // A fake input that emits NO event on click (mimics a no-`cancel` browser).
    const silentInput = {
      type: '',
      accept: '',
      files: [] as File[],
      addEventListener() {},
      click() {},
    };
    vi.spyOn(document, 'createElement').mockReturnValue(
      silentInput as unknown as HTMLElement,
    );

    const promise = pickBackupFile();
    // The dialog closes → the window regains focus with no `change` fired.
    window.dispatchEvent(new Event('focus'));
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('still returns the file text when a real selection races the refocus (no double-resolve)', async () => {
    const file = new File(['REAL'], 'backup.json', { type: 'application/json' });
    const fakeInput = makeFakeFileInput({ file, event: 'change' });
    vi.spyOn(document, 'createElement').mockReturnValue(
      fakeInput as unknown as HTMLElement,
    );

    const promise = pickBackupFile();
    // The window also refocuses as the dialog closes; the `change` path must win.
    window.dispatchEvent(new Event('focus'));

    await expect(promise).resolves.toBe('REAL');
  });

  it('lets a later file change win when Safari refocuses before dispatching change', async () => {
    vi.useFakeTimers();
    const file = new File(['SAFARI'], 'backup.almamesh', {
      type: 'application/vnd.almamesh.backup',
    });
    const handlers: Record<string, Array<() => void>> = {};
    const safariInput = {
      type: '',
      accept: '',
      files: [file],
      addEventListener(name: string, cb: () => void) {
        (handlers[name] ??= []).push(cb);
      },
      click() {
        window.dispatchEvent(new Event('focus'));
        setTimeout(() => {
          for (const cb of handlers.change ?? []) cb();
        }, 1);
      },
    };
    vi.spyOn(document, 'createElement').mockReturnValue(
      safariInput as unknown as HTMLElement,
    );

    const promise = pickBackupFile();
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual(expect.any(Uint8Array));
    vi.useRealTimers();
  });

  /** A multi-MB backup whose bytes take `delayMs` to arrive (iCloud Drive, a slow iPhone). */
  function slowFile(delayMs: number): { file: File; bytes: Uint8Array } {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.set(new TextEncoder().encode('SQLite format 3\0'));
    const file = new File([bytes], 'backup.almamesh', { type: 'application/vnd.almamesh.backup' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          setTimeout(() => resolve(bytes.buffer), delayMs);
        }),
    });
    return { file, bytes };
  }

  function safariInputFor(file: File, changeAfterMs: number) {
    const handlers: Record<string, Array<() => void>> = {};
    return {
      type: '',
      accept: '',
      files: [file],
      addEventListener(name: string, cb: () => void) {
        (handlers[name] ??= []).push(cb);
      },
      click() {
        // iOS Safari: the window refocuses first, `change` follows.
        window.dispatchEvent(new Event('focus'));
        setTimeout(() => {
          for (const cb of handlers.change ?? []) cb();
        }, changeAfterMs);
      },
    };
  }

  it('returns a slow multi-MB file instead of calling it cancelled (iOS focus-before-change)', async () => {
    vi.useFakeTimers();
    const { file, bytes } = slowFile(2_000);
    vi.spyOn(document, 'createElement').mockReturnValue(
      safariInputFor(file, 1) as unknown as HTMLElement,
    );

    const promise = pickBackupFile();
    await vi.advanceTimersByTimeAsync(2_500);

    const picked = await promise;
    expect(picked).toBeInstanceOf(Uint8Array);
    expect((picked as Uint8Array).byteLength).toBe(bytes.byteLength);
    vi.useRealTimers();
  });

  it('reads a selected file even when Safari publishes `change` long after the refocus', async () => {
    vi.useFakeTimers();
    const { file, bytes } = slowFile(10);
    vi.spyOn(document, 'createElement').mockReturnValue(
      safariInputFor(file, 1_500) as unknown as HTMLElement,
    );

    const promise = pickBackupFile();
    await vi.advanceTimersByTimeAsync(2_000);

    const picked = await promise;
    expect(picked).toBeInstanceOf(Uint8Array);
    expect((picked as Uint8Array).byteLength).toBe(bytes.byteLength);
    vi.useRealTimers();
  });
});
