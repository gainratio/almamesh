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

const BINARY_BACKUP_PICKER_TYPE: BackupPickerType = {
  description: 'Cloud or binary AlmaMesh backup',
  accept: { 'application/octet-stream': ['.almamesh', '.sqlite3', '.sqlite', '.db'] },
};

const ALL_BACKUP_PICKER_TYPES = [
  ALMAMESH_PICKER_TYPE,
  SQLITE_PICKER_TYPE,
  JSON_PICKER_TYPE,
  BINARY_BACKUP_PICKER_TYPE,
];
/** FileSaver.js's figure: WebKit can read a download's Blob URL long after the click. */
const DOWNLOAD_BLOB_URL_LIFETIME_MS = 40_000;
/**
 * When iOS Safari populates `input.files[0]` before refocus and drops `change`
 * on a detached input, read it promptly (300 ms) rather than making the user wait.
 */
const SAFARI_FOCUS_READ_MS = 300;
/**
 * When `input.files` is still empty on refocus, allow cloud file providers
 * (Google Drive, iCloud Drive, Android DocumentsUI) one bounded window to finish
 * downloading and dispatch `change` before settling as cancelled on no-`cancel` browsers.
 */
const CLOUD_PICKER_CANCEL_GRACE_MS = 30_000;
let cancelPendingInputPick: (() => void) | undefined;
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
export type BackupShareResult = 'shared' | 'cancelled' | 'gesture_expired';

function toBackupFileObject(suggestedName: string, content: BackupFileContent): File {
  const part =
    typeof content === 'string'
      ? content
      : Uint8Array.from(content).buffer;
  // Use application/octet-stream for Web Share so iOS/macOS/Android cloud targets
  // (Google Drive, Files, iCloud Drive) accept `.almamesh` without filtering out vnd.* types.
  return new File([part], suggestedName, { type: 'application/octet-stream' });
}

/** True when this browser supports sharing `.almamesh` files to native Save/Cloud apps (Files, Google Drive, iCloud). */
export function canShareBackupFiles(): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function' ||
    typeof File === 'undefined'
  ) {
    return false;
  }
  try {
    const probe = new File([new Uint8Array([0])], 'almamesh-backup.almamesh', {
      type: 'application/octet-stream',
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Open the OS Share / Save sheet (`Save to Files`, `Google Drive`, `iCloud Drive`) for an
 * already-encrypted backup. Returns `'gesture_expired'` if scrypt outlived transient user
 * activation so the UI can complete sharing on a fresh 1-tap gesture without re-sealing.
 */
export async function shareBackupFile(
  suggestedName: string,
  content: BackupFileContent,
): Promise<BackupShareResult> {
  const file = toBackupFileObject(suggestedName, content);
  try {
    await navigator.share({ files: [file], title: suggestedName });
    return 'shared';
  } catch (error) {
    if (isAbortError(error)) return 'cancelled';
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'gesture_expired';
    }
    throw error;
  }
}

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
  cancelPendingInputPick?.();
  return new Promise<BackupFileContent | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept =
      'application/octet-stream,application/vnd.almamesh.backup,application/vnd.sqlite3,application/x-sqlite3,application/json,.almamesh,.sqlite3,.sqlite,.db,.json';

    let settled = false;
    let reading = false;
    let focusHandled = false;
    let safariTimer: ReturnType<typeof setTimeout> | undefined;
    let cloudCancelTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPending = () => {
      if (cancelPendingInputPick === cancelThisPick) cancelPendingInputPick = undefined;
    };
    const cleanup = () => {
      clearPending();
      clearTimeout(safariTimer);
      clearTimeout(cloudCancelTimer);
      window.removeEventListener('focus', onFocus);
      input.removeEventListener?.('change', onChange);
      input.removeEventListener?.('cancel', onCancel);
    };
    const settle = (value: BackupFileContent | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const cancelThisPick = () => settle(null);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    // Once a file is chosen, detach picker listeners and clear `cancelPendingInputPick`
    // immediately so neither refocus timers nor a second button tap cancels an active read.
    const read = (file: File) => {
      if (reading || settled) return;
      reading = true;
      cleanup();
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
    const onCancel = () => settle(null);
    const onFocus = () => {
      if (focusHandled || reading || settled) return;
      focusHandled = true;
      safariTimer = setTimeout(() => {
        if (reading || settled) return;
        const file = input.files?.[0];
        if (file !== undefined) {
          read(file);
          return;
        }
        cloudCancelTimer = setTimeout(() => {
          if (reading || settled) return;
          const lateFile = input.files?.[0];
          if (lateFile !== undefined) read(lateFile);
          else settle(null);
        }, CLOUD_PICKER_CANCEL_GRACE_MS - SAFARI_FOCUS_READ_MS);
      }, SAFARI_FOCUS_READ_MS);
    };

    cancelPendingInputPick = cancelThisPick;
    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', onCancel, { once: true });
    window.addEventListener('focus', onFocus);
    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}
