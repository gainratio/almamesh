/** Browser-only file I/O for portable AlmaMesh backups. */

export type BackupFileContent = string | Uint8Array;
export const MAX_BACKUP_FILE_BYTES = 128 * 1024 * 1024;

interface BackupPickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface BackupWritable {
  write(data: BackupFileContent): Promise<void>;
  close(): Promise<void>;
}

interface BackupFileHandle {
  createWritable(): Promise<BackupWritable>;
  getFile(): Promise<File>;
  /** Chromium only: delete the file this handle points at. */
  remove?(): Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: BackupPickerType[];
}

interface OpenFilePickerOptions {
  types?: BackupPickerType[];
  multiple?: boolean;
}

interface FileSystemAccessWindow {
  showSaveFilePicker(options: SaveFilePickerOptions): Promise<BackupFileHandle>;
  showOpenFilePicker(options: OpenFilePickerOptions): Promise<BackupFileHandle[]>;
}

const JSON_PICKER_TYPE: BackupPickerType = {
  description: 'Encrypted or legacy AlmaMesh backup',
  accept: { 'application/json': ['.json'] },
};

const ALMAMESH_PICKER_TYPE: BackupPickerType = {
  description: 'Encrypted AlmaMesh backup',
  accept: { 'application/vnd.almamesh.backup': ['.almamesh'] },
};

const SQLITE_PICKER_TYPE: BackupPickerType = {
  description: 'Portable AlmaMesh SQLite backup',
  accept: { 'application/vnd.sqlite3': ['.sqlite3', '.sqlite', '.db'] },
};

const ALL_BACKUP_PICKER_TYPES = [ALMAMESH_PICKER_TYPE, SQLITE_PICKER_TYPE, JSON_PICKER_TYPE];
/** FileSaver.js's figure: WebKit can read a download's Blob URL long after the click. */
const DOWNLOAD_BLOB_URL_LIFETIME_MS = 40_000;
/** Give Safari's file input time to publish `change` after the window refocuses. */
const FILE_PICKER_CANCEL_GRACE_MS = 300;
const SQLITE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  return SQLITE_HEADER.every((value, index) => bytes[index] === value);
}

function looksLikeJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b;
  }
  return false;
}

async function readBackupFile(file: File): Promise<BackupFileContent> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error('That backup is too large to open safely.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (hasSqliteHeader(bytes)) return bytes;
  // Only decode bytes with the lexical prefix of JSON. Unknown binary stays
  // binary so validation can reject it without treating arbitrary bytes as text.
  if (
    looksLikeJson(bytes) ||
    file.type.toLowerCase() === 'application/json' ||
    file.name.toLowerCase().endsWith('.json')
  ) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return bytes;
    }
  }
  return bytes;
}

function pickerTypeFor(suggestedName: string, content: BackupFileContent): BackupPickerType {
  if (/\.almamesh$/i.test(suggestedName)) return ALMAMESH_PICKER_TYPE;
  return content instanceof Uint8Array || /\.(?:sqlite3?|db)$/i.test(suggestedName)
    ? SQLITE_PICKER_TYPE
    : JSON_PICKER_TYPE;
}

function mimeTypeFor(suggestedName: string, content: BackupFileContent): string {
  if (/\.almamesh$/i.test(suggestedName)) return 'application/vnd.almamesh.backup';
  return pickerTypeFor(suggestedName, content) === SQLITE_PICKER_TYPE
    ? 'application/vnd.sqlite3'
    : 'application/json';
}

export type BackupSaveResult = 'saved' | 'cancelled' | 'unverified';

/**
 * Where a backup will be saved, chosen BEFORE the backup is built.
 *
 * Chrome's save picker needs transient user activation, which expires about
 * 5 s after the click. Building a backup (flush, SQLite export, validation,
 * PBKDF2) can take longer than that on a slow phone, so the picker is opened
 * first, inside the click, and the bytes are written to it afterwards.
 */
export interface BackupSaveTarget {
  /** Resolves once the user picked a place ('chosen') or dismissed the picker. */
  readonly choice: Promise<'chosen' | 'cancelled'>;
  /** Write the finished backup. The download fallback cannot prove completion: 'unverified'. */
  write(content: BackupFileContent): Promise<BackupSaveResult>;
  /** Nothing will be written (the backup failed): remove the empty file the picker made. */
  discard(): Promise<void>;
}

function hasSavePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

function pickerSaveTarget(suggestedName: string, type: BackupPickerType): BackupSaveTarget {
  // Called synchronously by the click handler: this line is the gesture.
  const handle = (window as unknown as FileSystemAccessWindow).showSaveFilePicker({
    suggestedName,
    types: [type],
  });
  const choice = handle.then(
    () => 'chosen' as const,
    (error: unknown) => {
      if (isAbortError(error)) return 'cancelled' as const;
      throw error;
    },
  );
  return {
    choice,
    async write(content) {
      if ((await choice) === 'cancelled') return 'cancelled';
      try {
        const writable = await (await handle).createWritable();
        await writable.write(content);
        await writable.close();
        return 'saved';
      } catch (error) {
        if (isAbortError(error)) return 'cancelled';
        throw error;
      }
    },
    async discard() {
      if ((await choice.catch(() => 'cancelled')) === 'cancelled') return;
      // Best effort: only Chromium can delete it, and a leftover empty file is harmless.
      await (await handle).remove?.().catch(() => undefined);
    },
  };
}

function downloadSaveTarget(suggestedName: string): BackupSaveTarget {
  return {
    choice: Promise.resolve('chosen'),
    async write(content) {
      downloadFile(suggestedName, content);
      // The anchor-download fallback has no completion event. A normal export can
      // report that it started, while a destructive restore must ask the user to
      // confirm the safety file actually appeared.
      return 'unverified';
    },
    discard: async () => undefined,
  };
}

/** Open the save picker NOW (call this first, inside the click), write later. */
export function openBackupSaveTarget(suggestedName: string): BackupSaveTarget {
  return hasSavePicker()
    ? pickerSaveTarget(suggestedName, pickerTypeFor(suggestedName, ''))
    : downloadSaveTarget(suggestedName);
}

/** Pick a place and save in one step (the backup is already built). */
export async function saveBackupFile(
  suggestedName: string,
  content: BackupFileContent,
): Promise<BackupSaveResult> {
  const target = hasSavePicker()
    ? pickerSaveTarget(suggestedName, pickerTypeFor(suggestedName, content))
    : downloadSaveTarget(suggestedName);
  if ((await target.choice) === 'cancelled') return 'cancelled';
  return target.write(content);
}

function downloadFile(suggestedName: string, content: BackupFileContent): void {
  const part =
    typeof content === 'string'
      ? content
      : Uint8Array.from(content).buffer;
  const blob = new Blob([part], { type: mimeTypeFor(suggestedName, content) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // WebKit may read the Blob URL well after the click task; revoking it early
  // silently empties the download.
  globalThis.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_BLOB_URL_LIFETIME_MS);
}

export async function pickBackupFile(): Promise<BackupFileContent | null> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as FileSystemAccessWindow).showOpenFilePicker({
        types: ALL_BACKUP_PICKER_TYPES,
        multiple: false,
      });
      if (handle === undefined) return null;
      return await readBackupFile(await handle.getFile());
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }

  return pickFileViaInput();
}

function pickFileViaInput(): Promise<BackupFileContent | null> {
  return new Promise<BackupFileContent | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/vnd.almamesh.backup,application/vnd.sqlite3,application/json,.almamesh,.sqlite3,.sqlite,.db,.json';

    let settled = false;
    let reading = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: BackupFileContent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // Once a file is chosen, only its read settles the pick: a multi-MB read
    // on a slow phone outlasts any refocus grace and must never become "cancelled".
    const read = (file: File) => {
      if (reading || settled) return;
      reading = true;
      clearTimeout(focusTimer);
      readBackupFile(file).then(settle, fail);
    };
    const onChange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        settle(null);
        return;
      }
      read(file);
    };
    // Refocus without a selection means the dialog was dismissed. iOS Safari
    // refocuses BEFORE it dispatches `change`, sometimes by seconds, but the
    // chosen file is already on `input.files`: read it rather than cancel.
    const onFocus = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (reading) return;
        const file = input.files?.[0];
        if (file === undefined) settle(null);
        else read(file);
      }, FILE_PICKER_CANCEL_GRACE_MS);
    };

    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
