import { describe, expect, it } from 'vitest'
import { cachePoolDirectory } from '../../scripts/exitGateDurability.mjs'

// @gainratio/browser 0.3.0 keeps the engine cache in ONE SQLite database in an
// opfs-sahpool (OPFS directory `.<pool>`), not as `chunk/` + `active*` files.
describe('exit-gate OPFS durability probe', () => {
  it('names the sahpool directory of a persistent engine cache', () => {
    expect(cachePoolDirectory({ persistence: 'opfs', pool: 'edgeproc-browser-chunks', file: '/edgeproc-browser-chunks' }))
      .toBe('.edgeproc-browser-chunks')
  })

  it('has no directory for an in-memory cache or an unknown one', () => {
    expect(cachePoolDirectory({ persistence: 'memory', reason: 'opfs-unavailable' })).toBeNull()
    expect(cachePoolDirectory(null)).toBeNull()
    expect(cachePoolDirectory(undefined)).toBeNull()
  })
})
