/**
 * Where the engine's signed-bundle cache lives in OPFS. Since
 * @gainratio/browser 0.3.0 it is one SQLite database in an opfs-sahpool,
 * whose OPFS directory is `.<pool>`; an in-memory cache has none.
 */
export function cachePoolDirectory(storage) {
  return storage?.persistence === 'opfs' ? `.${storage.pool}` : null
}
