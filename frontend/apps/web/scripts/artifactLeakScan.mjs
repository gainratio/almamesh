#!/usr/bin/env node
/**
 * The last check before the macOS WebKit lane uploads its evidence directory
 * (.github/workflows/webkit-macos.yml). It looks for the runner's secrets in
 * what is about to be uploaded, by content:
 *
 *   - the value of every environment variable of 8 or more characters, except
 *     the public ones listed in PUBLIC_ENV_NAMES (paths and run metadata that
 *     traces and logs legitimately contain);
 *   - every value and URL credential in ~/.gitconfig, and every
 *     login/password/account in ~/.netrc.
 *
 * Matching ignores case. Each value is also looked for URL-encoded,
 * JSON-escaped, base64 and base64url at all three byte offsets (so
 * `Basic base64("user:" + value)` is caught), hex and UTF-16LE; in file names;
 * inside gzip files; and inside zip files wherever the zip starts in a file (a
 * Playwright trace is a compressed zip). A symbolic link fails the scan too,
 * because the upload would follow it out of the directory, and so does a file
 * that starts as a zip or gzip but cannot be opened.
 *
 * Deliberate limits, not checked: values under 8 characters (too many honest
 * matches); a value split across files or across chunks of a stream; a value
 * shown as pixels in a video frame or screenshot; other encodings or
 * encryption (the backups the export journeys write are encrypted).
 *
 * On a match it prints only what matched by NAME (never the value), deletes
 * the directory and exits 1. A clean or missing directory exits 0.
 *
 *   node scripts/artifactLeakScan.mjs <dir>
 *
 * The lane job holds no secrets and checks out with persist-credentials: false;
 * this scan is the backstop for evidence the lane writes by accident.
 */

import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { unzipSync } from 'fflate'

export const MIN_SECRET_LENGTH = 8

/**
 * Names whose values are public and show up in honest evidence: the shell's
 * paths and locale, and the GitHub/runner run metadata and directories (a
 * trace records source paths under GITHUB_WORKSPACE; WebKit logs name TMPDIR).
 * A name not listed here is treated as a secret.
 */
export const PUBLIC_ENV_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PWD', 'OLDPWD', 'INIT_CWD', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', '_',
  '__CF_USER_TEXT_ENCODING', 'XPC_FLAGS', 'XPC_SERVICE_NAME',
  'GITHUB_WORKSPACE', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_SERVER_URL', 'GITHUB_API_URL',
  'GITHUB_GRAPHQL_URL', 'RUNNER_WORKSPACE', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'AGENT_TOOLSDIRECTORY', 'ImageOS', 'ImageVersion',
]

const PUBLIC = new Set(PUBLIC_ENV_NAMES)
const ZIP_MAGIC = Buffer.from('PK\x03\x04', 'latin1')
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
const MAX_GUNZIP_BYTES = 512 * 2 ** 20

/**
 * The base64 characters that encode `value` whatever byte offset it starts
 * at: encode it behind 0, 1 and 2 bytes of padding and keep only the groups
 * of four characters that come from the value alone.
 */
function base64Forms(value) {
  const bytes = Buffer.from(value)
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64')
    return encoded.slice(offset === 0 ? 0 : 4, 4 * Math.floor((offset + bytes.length) / 3))
  })
}

/** The forms a value takes when a log, a trace or a URL writes it, lowercased (matching ignores case). */
function variants(value) {
  const base64 = base64Forms(value)
  const forms = new Set([
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    ...base64,
    ...base64.map((form) => form.replaceAll('+', '-').replaceAll('/', '_')),
    Buffer.from(value).toString('hex'),
    Buffer.from(value, 'utf16le').toString('latin1'),
  ])
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH).map((form) => form.toLowerCase())
}

function needle(label, value) {
  return { label, values: variants(value) }
}

export function envNeedles(env) {
  return Object.entries(env)
    .filter(([name, value]) => !PUBLIC.has(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(([name, value]) => needle(`environment variable ${name}`, value))
}

/**
 * What can be secret on a ~/.gitconfig line: a value (`extraheader = ...`) or
 * the credentials in a section's URL (`[url "https://user:token@host/"]`).
 * Keys, section names and bare URLs are generic (`helper =` also appears
 * inside WebAssembly, `https://github.com` in any page).
 */
function gitconfigSecret(line) {
  if (line.startsWith('[')) return /:\/\/([^@/]+)@/.exec(line)?.[1] ?? ''
  const equals = line.indexOf('=')
  return equals === -1 ? '' : line.slice(equals + 1).trim()
}

export function gitconfigNeedles(text) {
  return text
    .split('\n')
    .map((line, index) => [index + 1, gitconfigSecret(line.trim())])
    .filter(([, secret]) => secret.length >= MIN_SECRET_LENGTH)
    .map(([number, secret]) => needle(`~/.gitconfig line ${number}`, secret))
}

export function netrcNeedles(text) {
  const tokens = text.split(/\s+/)
  return tokens.flatMap((token, index) => {
    const value = tokens[index + 1] ?? ''
    if (!['login', 'password', 'account'].includes(token) || value.length < MIN_SECRET_LENGTH) return []
    return [needle(`~/.netrc ${token}`, value)]
  })
}

function unzipAt(bytes, offset) {
  try {
    return unzipSync(bytes.subarray(offset))
  } catch {
    return null
  }
}

/**
 * The entries of the first zip found in `bytes`. A zip at offset 0 that does
 * not open fails closed; the signature later in a file (a video can hold it
 * by chance) counts only when a zip really opens there.
 */
function zipEntries(bytes, found) {
  for (let at = bytes.indexOf(ZIP_MAGIC); at !== -1; at = bytes.indexOf(ZIP_MAGIC, at + 1)) {
    const entries = unzipAt(bytes, at)
    if (entries !== null) return entries
    if (at === 0) found.add('an unreadable zip file')
  }
  return {}
}

function gunzipped(bytes, found) {
  if (!bytes.subarray(0, 2).equals(GZIP_MAGIC)) return null
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_GUNZIP_BYTES })
  } catch {
    found.add('an unreadable gzip file')
    return null
  }
}

function contains(bytes, found, needles) {
  const text = bytes.toString('latin1').toLowerCase()
  for (const { label, values } of needles) if (values.some((value) => text.includes(value))) found.add(label)
  const inflated = gunzipped(bytes, found)
  if (inflated !== null) contains(inflated, found, needles)
  for (const [name, data] of Object.entries(zipEntries(bytes, found))) {
    contains(Buffer.from(name), found, needles)
    contains(Buffer.from(data), found, needles)
  }
}

function walk(root, dir, found, needles) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    contains(Buffer.from(relative(root, path)), found, needles)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) found.add('a symbolic link')
    else if (stat.isDirectory()) walk(root, path, found, needles)
    else if (stat.isFile()) contains(readFileSync(path), found, needles)
  }
}

/** The labels of every needle found under `dir`, sorted; empty when clean. */
export function scanDirectory(dir, needles) {
  const found = new Set()
  walk(dir, dir, found, needles)
  return [...found].sort()
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function main(dir) {
  if (!dir) {
    console.error('usage: artifactLeakScan.mjs <dir>')
    return 2
  }
  if (!existsSync(dir)) {
    console.log(`artifact leak scan: ${dir} does not exist, nothing to upload`)
    return 0
  }
  const home = process.env.HOME ?? homedir()
  const needles = [
    ...envNeedles(process.env),
    ...gitconfigNeedles(readIfPresent(join(home, '.gitconfig'))),
    ...netrcNeedles(readIfPresent(join(home, '.netrc'))),
  ]
  const leaks = scanDirectory(dir, needles)
  if (leaks.length === 0) {
    console.log(`artifact leak scan: ${dir} is clean (${needles.length} secrets looked for)`)
    return 0
  }
  for (const leak of leaks) console.error(`artifact leak scan: found ${leak} in ${dir}`)
  rmSync(dir, { recursive: true, force: true })
  console.error(`artifact leak scan: deleted ${dir}; nothing will be uploaded`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]))
