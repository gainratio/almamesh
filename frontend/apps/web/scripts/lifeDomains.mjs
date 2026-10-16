// The life domains the app renders, read from the one source of truth
// (LIFE_DOMAINS in src/lib/lifeAtlas.ts) so the plain-node verify scripts never
// hard-code a count. Checked against the TypeScript export by
// src/lib/__tests__/lifeDomainsScript.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/lifeAtlas.ts'), 'utf-8')
const body = source.match(/export const LIFE_DOMAINS[^=]*=\s*\[([^\]]*)\]/)?.[1]
if (!body) throw new Error('LIFE_DOMAINS not found in src/lib/lifeAtlas.ts')

export const LIFE_DOMAINS = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
