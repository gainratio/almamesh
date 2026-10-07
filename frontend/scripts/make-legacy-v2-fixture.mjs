#!/usr/bin/env node
/**
 * Regenerate legacy-v2.json: a backup exactly as the format-v2 writer wrote it.
 *
 *   node frontend/scripts/make-legacy-v2-fixture.mjs
 *
 * Why this exists: the first v2 fixture carried a zustand-shaped AI setting
 * (`{"state":{...},"version":1}`). No release ever wrote that. The real v2
 * writer stored the flat object `writeLlmSettings` keeps in localStorage, and
 * the app refused the fake one ("Portable LLM setting "state" is invalid").
 *
 * Reconstructed from commit fdfd171 ("carry settings and AI key in a
 * password-encrypted export"), which introduced format v2:
 *  - `packages/store/src/portableBundle.ts` `sealPortableBundle`: header fields,
 *    PBKDF2-SHA256 600,000 iterations → AES-GCM-256, 16-byte salt, 12-byte IV,
 *    the header array below as GCM additional data, plaintext
 *    `JSON.stringify({ database: base64, settings })`, file `JSON.stringify(sealed, null, 2)`.
 *  - `packages/store/src/portableSettings.ts` `collectPortableSettings`: the raw
 *    localStorage string under `almamesh-llm-settings`.
 *  - `packages/llm/src/settings.ts` `writeLlmSettings`: that string is
 *    `JSON.stringify({ apiBase, apiKey, interpretationModel, chatModel, privacyMode })`
 *    (the same shape fdfd171's own round-trip test used).
 *
 * The SQLite database is taken from the current legacy-v2.json (decrypted with
 * the same scheme), so its bytes, and `databaseSha256` in manifest.json, do not
 * change. The password stays the 5-character "short": it proves a short legacy
 * password still opens. The API key is a plainly fake value, not secret-shaped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const FILE = fileURLToPath(new URL('../packages/store/src/__fixtures__/legacy-backups/legacy-v2.json', import.meta.url));
const PASSPHRASE = 'short';
const ITERATIONS = 600_000;
const LLM_SETTINGS = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key-not-a-secret',
  interpretationModel: 'synthetic/frontier',
  chatModel: 'synthetic/fast',
  privacyMode: 'standard',
};

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

function headerBytes(h) {
  return new TextEncoder().encode(
    JSON.stringify([
      h.format, h.formatVersion, h.app.version, h.exportedAt, h.encryption,
      h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.iv,
    ]),
  );
}

async function deriveKey(salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function readDatabase() {
  const sealed = JSON.parse(readFileSync(FILE, 'utf8'));
  const { ciphertext, ...header } = sealed;
  const key = await deriveKey(unb64(sealed.kdf.salt), sealed.kdf.iterations);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: headerBytes(header) },
    key,
    unb64(ciphertext),
  );
  return unb64(JSON.parse(new TextDecoder().decode(plain)).database);
}

async function seal(database) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: 'almamesh-backup',
    formatVersion: 2,
    app: { version: 'legacy' },
    exportedAt: '2026-01-02T03:04:05.000Z',
    encryption: 'aes-gcm',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) },
    iv: b64(iv),
  };
  const settings = { 'almamesh-llm-settings': JSON.stringify(LLM_SETTINGS) };
  const plaintext = new TextEncoder().encode(JSON.stringify({ database: b64(database), settings }));
  const key = await deriveKey(salt, ITERATIONS);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerBytes(header) }, key, plaintext);
  return JSON.stringify({ ...header, ciphertext: b64(new Uint8Array(cipher)) }, null, 2);
}

writeFileSync(FILE, `${await seal(await readDatabase())}\n`);
console.log(`wrote ${FILE}`);
