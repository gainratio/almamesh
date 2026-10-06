// @vitest-environment node
/**
 * Every backup an earlier release wrote must still restore — through the REAL
 * decrypt → stage → legacy-settings merge → SQLite validation path.
 *
 * The neighbouring backupService tests inject `readPortableState` and
 * `mergeLegacyPreferences`; that is how a v2 fixture whose AI settings the real
 * validator rejects ("Portable LLM setting "state" is invalid") once passed CI.
 * Here nothing in that chain is mocked. Node has no Worker, so the SQLite
 * transport is the in-process stand-in (src/test/inProcessSqliteWorker.ts),
 * which runs the real pinned SQLite WASM runtime and store.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decodePortablePreferences,
  PORTABLE_PREFERENCES_KEY,
  readPortableStateDatabase,
} from '@almamesh/store';

import { InProcessSqliteWorker } from '../test/inProcessSqliteWorker';
import { stageBackupImport, type StagedImport } from './backupService';

const LEGACY = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/store/src/__fixtures__/legacy-backups',
);
const manifest = JSON.parse(readFileSync(join(LEGACY, 'manifest.json'), 'utf8')) as Record<
  string,
  { readonly passphrase: string }
>;

async function stageFixture(name: string, binary: boolean): Promise<StagedImport> {
  const path = join(LEGACY, name);
  const content = binary ? new Uint8Array(readFileSync(path)) : readFileSync(path, 'utf8');
  return stageBackupImport(content, manifest[name]!.passphrase);
}

function profileNames(staged: StagedImport): string[] {
  const profiles = staged.envelope.stores['almamesh-profiles'] as
    | { state: { profiles: Record<string, { name: string }> } }
    | undefined;
  return Object.values(profiles?.state.profiles ?? {}).map((profile) => profile.name).sort();
}

/** The AI settings the staged database will restore, read back through real SQLite. */
async function llmSettingsIn(staged: StagedImport): Promise<unknown> {
  if (staged.kind !== 'bundle') throw new Error(`expected a bundle, got ${staged.kind}`);
  const snapshot = await readPortableStateDatabase(staged.bytes);
  const preferences = decodePortablePreferences(snapshot.values.get(PORTABLE_PREFERENCES_KEY) ?? '');
  return JSON.parse(preferences.values['almamesh-llm-settings'] ?? 'null');
}

beforeAll(() => {
  vi.stubGlobal('Worker', InProcessSqliteWorker);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('legacy backups restore through the real stage path (no mocks)', () => {
  it('v3 .almamesh: decrypts and stages the real exported people', async () => {
    const staged = await stageFixture('legacy-v3.almamesh', true);
    expect(staged).toMatchObject({ kind: 'bundle', wasEncrypted: true });
    expect(profileNames(staged)).toEqual(['Portable Ada', 'Portable Grace']);
  }, 60_000);

  it('v2 JSON: decrypts, merges the flat AI settings into the database, and stages it', async () => {
    const staged = await stageFixture('legacy-v2.json', false);
    expect(staged).toMatchObject({ kind: 'bundle', wasEncrypted: true });
    expect(profileNames(staged)).toEqual(['Portable Ada', 'Portable Grace']);
    expect(await llmSettingsIn(staged)).toEqual({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key-not-a-secret',
      interpretationModel: 'synthetic/frontier',
      chatModel: 'synthetic/fast',
      privacyMode: 'standard',
    });
  }, 60_000);

  it('v1 JSON: decrypts the store backup and stages its person', async () => {
    const staged = await stageFixture('legacy-v1.json', false);
    expect(staged).toMatchObject({ kind: 'json', wasEncrypted: true });
    expect(profileNames(staged)).toEqual(['Legacy V1 Ada']);
  }, 60_000);
});
