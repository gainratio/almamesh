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

export async function saveBackupFile(
  suggestedName: string,
  content: BackupFileContent,
): Promise<'saved' | 'cancelled' | 'unverified'> {
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as FileSystemAccessWindow).showSaveFilePicker({
        suggestedName,
        types: [pickerTypeFor(suggestedName, content)],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (isAbortError(error)) return 'cancelled';
      throw error;
    }
  }

  downloadFile(suggestedName, content);
  // The anchor-download fallback has no completion event. A normal export can
  // report that it started, while a destructive restore must ask the user to
  // confirm the safety file actually appeared.
  return 'unverified';
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
  // Safari may not consume the Blob URL until the click task completes.
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
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
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: BackupFileContent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      resolve(value);
    };
    const onChange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        settle(null);
        return;
      }
      void readBackupFile(file).then(settle, reject);
    };
    // Refocus without a `change` means the dialog was dismissed. If a real
    // selection wins the race, settle() cancels this timer. Safari can emit
    // focus before change, so do not treat the first refocus task as a cancel.
    const onFocus = () => {
      focusTimer = setTimeout(() => settle(null), FILE_PICKER_CANCEL_GRACE_MS);
    };

    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
