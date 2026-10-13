import type { PortableStatePersistence } from '@almamesh/store'

/**
 * Where the engine's bundle cache may live. Only when the app's own data
 * already runs on SQLite in memory (OPFS refused, and the UI says so) may the
 * engine cache be in memory too; everywhere else it is SQLite on OPFS or a
 * typed refusal.
 */
export function engineCacheFallback(persistence: PortableStatePersistence): 'none' | 'memory' {
  return persistence === 'memory' ? 'memory' : 'none'
}
