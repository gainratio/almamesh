/**
 * The one seam for touching `localStorage`.
 *
 * Reading `globalThis.localStorage` is not a safe property read: when a browser
 * blocks site storage (Safari with "Block all cookies", some embedded or
 * locked-down profiles) the GETTER throws `SecurityError: The operation is
 * insecure.` A bare read at module scope once took down the whole entry chunk
 * and left every app route blank in Safari. Go through these helpers instead of
 * reading the global directly.
 */

function readGlobalLocalStorage(): Partial<Storage> | undefined {
  return (globalThis as { localStorage?: Partial<Storage> }).localStorage;
}

/**
 * localStorage as this app may use it: read a legacy value, or retire it. No
 * `setItem` — SQLite is the only store for app data (sessionStorage reload
 * flags in apps/web are the one allowed browser-storage write).
 */
export type LegacyWebStorage = Pick<Storage, 'getItem' | 'removeItem'>;

/** The browser's Storage (read/retire only), or undefined when absent, partial, or blocked. Never throws. */
export function browserLocalStorage(): LegacyWebStorage | undefined {
  let storage: Partial<Storage> | undefined;
  try {
    storage = readGlobalLocalStorage();
  } catch {
    return undefined;
  }
  if (
    typeof storage?.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    return undefined;
  }
  return storage as LegacyWebStorage;
}

/**
 * True when the browser refuses site storage outright (the getter throws).
 * A runtime that simply has no Web Storage (Node tests, prerender) is not
 * "blocked"; it is just not a browser.
 */
export function siteStorageBlocked(): boolean {
  try {
    readGlobalLocalStorage();
    return false;
  } catch {
    return true;
  }
}
