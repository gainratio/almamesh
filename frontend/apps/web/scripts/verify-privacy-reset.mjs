import { chromium } from '@playwright/test';

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error('Usage: node verify-privacy-reset.mjs <base-url>');

const PROFILE_ID = 'privacy-reset-sqlite-profile';
const PROFILE_NAME = 'SQLite Reset Proof';
const PRIVATE_CREDENTIAL = 'sk-privacy-reset-never-plaintext';
const PASSPHRASE = 'privacy reset passphrase';
const BUNDLE_MAGIC = [0x41, 0x4c, 0x4d, 0x41, 0x4d, 0x45, 0x53, 0x48];
const BUNDLE_FORMAT_VERSION = 3;
const BUNDLE_PBKDF2_ITERATIONS = 600_000;
const SQLITE_HEADER = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];
const origin = new URL(baseUrl).origin;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(({ profileId, privateCredential, passphrase }) => {
  let target = window;
  while (target) {
    Reflect.deleteProperty(target, 'showSaveFilePicker');
    target = Object.getPrototypeOf(target);
  }
  const createObjectUrl = URL.createObjectURL.bind(URL);
  // Independent format-v3 opener. The authenticated 64-byte header carries the
  // format, KDF, salt, IV, timestamp and lengths; the plaintext is exactly the
  // canonical SQLite file, with no second settings payload.
  const openBundle = async (file) => {
    const header = file.slice(0, 64);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const iterations = view.getUint32(16, false);
    const base = await window.crypto.subtle.importKey(
      'raw', new window.TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: header.slice(36, 52), iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: header.slice(52, 64), additionalData: header },
      key, file.slice(64),
    );
    return { database: new Uint8Array(plain), header, iterations };
  };
  const includes = (haystack, text) => {
    const needle = new window.TextEncoder().encode(text);
    return haystack.some((_, offset) =>
      offset + needle.length <= haystack.length &&
      needle.every((value, index) => haystack[offset + index] === value),
    );
  };
  URL.createObjectURL = (blob) => {
    window.__almameshBackupEvidence = blob.arrayBuffer().then(async (buffer) => {
      const file = new Uint8Array(buffer);
      const { database: bytes, header, iterations } = await openBundle(file);
      const contains = (text) => {
        const needle = new window.TextEncoder().encode(text);
        return bytes.some((_, offset) =>
          offset + needle.length <= bytes.length &&
          needle.every((value, index) => bytes[offset + index] === value),
        );
      };
      return {
        type: blob.type,
        magic: [...header.slice(0, 8)],
        formatVersion: header[8],
        iterations,
        fileHasPlaintextCredential: includes(file, privateCredential),
        size: bytes.length,
        header: [...bytes.slice(0, 16)],
        pageSizeField: (bytes[16] << 8) | bytes[17],
        hasCanonicalLedger: contains('almamesh-deletion-tombstones'),
        hasProfile: contains(profileId),
        hasPrivateCredential: contains(privateCredential),
      };
    });
    return createObjectUrl(blob);
  };
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target;
      if (anchor instanceof window.HTMLAnchorElement && anchor.download) {
        window.__almameshBackupFilename = anchor.download;
      }
    },
    true,
  );
}, { profileId: PROFILE_ID, privateCredential: PRIVATE_CREDENTIAL, passphrase: PASSPHRASE });

const page = await context.newPage();
const errors = [];
const offOrigin = new Set();
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (new URL(request.url()).origin !== origin) offOrigin.add(request.url());
});

async function openKeyvalDatabase() {
  return page.evaluateHandle(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('keyval')) {
            request.result.createObjectStore('keyval');
          }
        };
        request.onsuccess = () => resolve(request.result);
      }),
  );
}

async function putIdbValue(key, value) {
  const database = await openKeyvalDatabase();
  try {
    await page.evaluate(
      ([db, entryKey, entryValue]) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction('keyval', 'readwrite');
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => resolve();
          transaction.objectStore('keyval').put(entryValue, entryKey);
        }),
      [database, key, value],
    );
  } finally {
    await database.evaluate((db) => db.close());
    await database.dispose();
  }
}

async function getIdbValue(key) {
  const database = await openKeyvalDatabase();
  try {
    return await page.evaluate(
      ([db, entryKey]) =>
        new Promise((resolve, reject) => {
          const request = db.transaction('keyval', 'readonly').objectStore('keyval').get(entryKey);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result ?? null);
        }),
      [database, key],
    );
  } finally {
    await database.evaluate((db) => db.close());
    await database.dispose();
  }
}

async function resetDiagnostics() {
  const confirm = page.getByTestId('reset-confirm');
  return {
    url: page.url(),
    errors,
    confirmCount: await confirm.count(),
    confirmDisabled: (await confirm.count()) > 0 ? await confirm.isDisabled() : null,
    body: (await page.locator('body').innerText()).slice(0, 500),
  };
}

async function exportBackup() {
  await page.evaluate(() => {
    delete window.__almameshBackupEvidence;
    delete window.__almameshBackupFilename;
  });
  await page.getByTestId('backup-passphrase-input').fill(PASSPHRASE);
  await page.getByTestId('backup-export-button').click();
  await page.getByTestId('backup-status').waitFor();
  await page.waitForFunction(
    () => window.__almameshBackupFilename && window.__almameshBackupEvidence,
  );
  return page.evaluate(async () => ({
    filename: window.__almameshBackupFilename,
    ...(await window.__almameshBackupEvidence),
  }));
}

function assertPortableBackup(exported, { expectProfile, expectCredential }) {
  if (!/^almamesh-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.almamesh$/.test(exported.filename)) {
    throw new Error(`Backup filename contract failed: ${exported.filename}`);
  }
  if (
    exported.type !== 'application/vnd.almamesh.backup' ||
    exported.formatVersion !== BUNDLE_FORMAT_VERSION ||
    exported.iterations !== BUNDLE_PBKDF2_ITERATIONS ||
    JSON.stringify(exported.magic) !== JSON.stringify(BUNDLE_MAGIC)
  ) {
    throw new Error(
      `Backup envelope contract failed: type=${exported.type}, version=${exported.formatVersion}, ` +
        `iterations=${exported.iterations}`,
    );
  }
  if (JSON.stringify(exported.header) !== JSON.stringify(SQLITE_HEADER)) {
    throw new Error(`Backup is not SQLite: ${JSON.stringify(exported.header)}`);
  }
  const pageSize = exported.pageSizeField === 1 ? 65_536 : exported.pageSizeField;
  if (
    pageSize < 512 ||
    pageSize > 65_536 ||
    (pageSize & (pageSize - 1)) !== 0 ||
    exported.size < pageSize ||
    exported.size % pageSize !== 0
  ) {
    throw new Error(
      `Backup SQLite page contract failed: size=${exported.size}, pageSize=${pageSize}`,
    );
  }
  if (!exported.hasCanonicalLedger) {
    throw new Error('Backup is SQLite but lacks the canonical AlmaMesh generation ledger');
  }
  if (exported.hasProfile !== expectProfile) {
    throw new Error(
      `Backup profile content differs: expected=${expectProfile}, actual=${exported.hasProfile}`,
    );
  }
  if (exported.fileHasPlaintextCredential) {
    throw new Error('Backup file leaked the LLM provider credential in plaintext');
  }
  if (exported.hasPrivateCredential !== expectCredential) {
    throw new Error(
      `Canonical SQLite AI settings differ: expected credential=${expectCredential}, actual=${exported.hasPrivateCredential}`,
    );
  }
}

try {
  // Seed a real pre-migration user row before any application JavaScript boots.
  // The export must prove that every row reached canonical SQLite, including
  // the AI credential needed to recreate the same app on another browser. The
  // outer transport must keep all of those bytes confidential.
  await page.goto(`${baseUrl}/robots.txt`, { waitUntil: 'domcontentloaded' });
  await putIdbValue(
    'almamesh-profiles',
    JSON.stringify({
      state: {
        profiles: {
          [PROFILE_ID]: {
            id: PROFILE_ID,
            name: PROFILE_NAME,
            createdAt: '2026-01-02T03:04:05.000Z',
            avatarTint: '#3A4FB0',
            relationship: 'self',
          },
        },
        activeProfileId: PROFILE_ID,
      },
      version: 1,
      datasetEpoch: 0,
    }),
  );
  await page.evaluate((privateCredential) => {
    localStorage.setItem(
      'almamesh-llm-settings',
      JSON.stringify({
        apiBase: 'http://127.0.0.1:11434/v1',
        apiKey: privateCredential,
        model: 'synthetic/privacy-proof',
        privacyMode: 'strict',
      }),
    );
  }, PRIVATE_CREDENTIAL);

  await page.goto(`${baseUrl}/settings/people`, { waitUntil: 'networkidle' });
  await page.getByTestId(`person-row-${PROFILE_ID}`).waitFor();
  if ((await getIdbValue('almamesh-profiles')) !== null) {
    throw new Error('Legacy profile row was not retired after SQLite migration');
  }

  await page.goto(`${baseUrl}/settings/data`, { waitUntil: 'networkidle' });
  if (await page.evaluate(() => 'showSaveFilePicker' in window)) {
    throw new Error('Native save picker could not be disabled for the download proof');
  }
  const exportButton = page.getByTestId('backup-export-button');
  try {
    await exportButton.waitFor({ timeout: 10_000 });
  } catch {
    const body = (await page.locator('body').innerText()).slice(0, 500);
    throw new Error(
      `Backup page unavailable at ${page.url()}: ${errors.join(' | ')} :: ${body}`,
    );
  }
  const exported = await exportBackup();
  assertPortableBackup(exported, { expectProfile: true, expectCredential: true });

  await page.goto(`${baseUrl}/settings/preferences`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('almamesh-chart', '1');
    localStorage.setItem('almamesh-interpretations', 'reset-proof');
  });
  await putIdbValue('almamesh-chart-library', 'reset-proof');
  try {
    await page.getByTestId('reset-start-fresh').click();
    await page.getByTestId('reset-confirm').click();
    await page.getByTestId('landing-nav-cta').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(
      () =>
        localStorage.getItem('almamesh-chart') === null &&
        localStorage.getItem('almamesh-interpretations') === null,
      undefined,
      { timeout: 10_000 },
    );
    if ((await getIdbValue('almamesh-chart-library')) !== null) {
      throw new Error('IndexedDB chart library survived reset');
    }
    if ((await getIdbValue('almamesh-profiles')) !== null) {
      throw new Error('IndexedDB profile residue survived reset');
    }
    if (new URL(page.url()).pathname !== '/') {
      throw new Error(`Reset route differs: ${page.url()}`);
    }
  } catch (error) {
    throw new Error(
      `Reset postcondition failed: ${error instanceof Error ? error.message : String(error)} :: ${JSON.stringify(await resetDiagnostics())}`,
      { cause: error },
    );
  }

  // A second export is a public-path, production-fidelity read of canonical
  // state after reset. secure_delete ensures the removed profile is absent not
  // only logically, but also from the portable bytes a user can download.
  await page.goto(`${baseUrl}/settings/data`, { waitUntil: 'networkidle' });
  const afterReset = await exportBackup();
  // "Start fresh" keeps portable preferences (resetEverything.ts), so the key remains.
  assertPortableBackup(afterReset, { expectProfile: false, expectCredential: true });
  if (offOrigin.size > 0) throw new Error(`Off-origin requests: ${[...offOrigin].join(', ')}`);
  if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log(
    `privacy: sealed v3 exact SQLite export (${exported.size} bytes), all portable state encrypted, ` +
      'durable canonical + legacy reset, landing, zero egress, clean console',
  );
} finally {
  await browser.close();
}
