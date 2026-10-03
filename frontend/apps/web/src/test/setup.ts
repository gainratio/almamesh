/**
 * Vitest setup file for React testing
 */
import '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, vi } from 'vitest';
import { describeLiveTimers, installLiveTimerTracking, teardownHazards } from './liveTimers';

// Before any module under test loads: some libraries arm timers at import time.
installLiveTimerTracking();

function isUsableStorage(value: unknown): value is Storage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const storage = value as Partial<Storage>;
  return (
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function' &&
    typeof storage.clear === 'function'
  );
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

// Node 25 exposes a partial `localStorage` shell when no
// `--localstorage-file` is configured. Keep browser tests deterministic and
// make direct test calls (`clear`, `setItem`, etc.) safe in both DOM and SSR
// suites without changing real browser storage behavior.
function readHostStorage(): unknown {
  try {
    return typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const hostStorage = readHostStorage();
const testStorage = isUsableStorage(hostStorage) ? hostStorage : createMemoryStorage();
if (!isUsableStorage(hostStorage)) {
  vi.stubGlobal('localStorage', testStorage);
  if (typeof window !== 'undefined') {
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: testStorage,
      });
    } catch {
      // A host may expose an unconfigurable storage getter; global calls are
      // still stubbed above, and browser code handles the getter defensively.
    }
  }
}

// Automatically cleanup after each test
afterEach(() => {
  cleanup();
});

// A timer still pending when a file finishes fires after Vitest tears the DOM
// down, where `window`/`requestAnimationFrame` are gone. Every test passes,
// Vitest reports an unhandled error, and the gate goes red at random. Fail the
// file that leaked it instead, with the stack that armed the timer.
afterAll(() => {
  const hazards = teardownHazards();
  if (hazards.length > 0) {
    throw new Error(
      `${hazards.length} timer(s) still pending when this test file finished. ` +
        'They would fire after the DOM environment is torn down. Clear them on ' +
        'unmount, or settle them inside the test.\n\n' +
        describeLiveTimers(hazards),
    );
  }
});

// Mock window.matchMedia. Guarded: a few suites (e.g. the Spec 064 prerender
// canary) run under `@vitest-environment node`, where no `window` exists —
// exactly the environment the build-time prerender executes in.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
