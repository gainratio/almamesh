/**
 * Scoped, expiring exceptions for `bun audit`.
 *
 * The list lives in security/audit-exceptions.json. Each entry silences ONE
 * GitHub advisory id via `bun audit --ignore=<GHSA id>` (bun matches GHSA or
 * numeric ids; CVE ids "are not in the registry data and don't match":
 * https://bun.com/docs/pm/cli/audit#filtering-options).
 *
 * The whole list is refused, failing the audit, when any entry lacks a reason,
 * owner or dependency path, has expired, or was granted for longer than
 * MAX_AUDIT_EXCEPTION_DAYS. That makes an exception cost a dated, reviewed
 * renewal instead of silently living forever.
 */
export const MAX_AUDIT_EXCEPTION_DAYS = 90
export const AUDIT_EXCEPTIONS_FILE = "security/audit-exceptions.json"

const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

export interface AuditException {
  readonly id: string
  readonly path: string
  readonly reason: string
  readonly owner: string
  readonly added: string
  readonly expires: string
}

/** Parses and validates the exception file; throws on the first violation. */
export function parseAuditExceptions(json: string, today: Date): AuditException[] {
  const entries = (JSON.parse(json) as { exceptions?: unknown }).exceptions
  if (!Array.isArray(entries)) throw new Error(`${AUDIT_EXCEPTIONS_FILE}: missing "exceptions" array`)
  const exceptions = entries.map((raw) => validated(raw as Record<string, unknown>, today))
  assertUniqueIds(exceptions)
  return exceptions
}

/** The exact `bun audit` arguments for a validated list: one --ignore per id. */
export function auditIgnoreArgs(exceptions: readonly AuditException[]): string[] {
  return exceptions.map((exception) => `--ignore=${exception.id}`)
}

function validated(raw: Record<string, unknown>, today: Date): AuditException {
  const id = requiredText(raw, "id", "?")
  if (!GHSA_ID.test(id)) throw new Error(`audit exception ${id}: id must be a single GHSA advisory id`)
  const exception = {
    id,
    path: requiredText(raw, "path", id),
    reason: requiredText(raw, "reason", id),
    owner: requiredText(raw, "owner", id),
    added: requiredText(raw, "added", id),
    expires: requiredText(raw, "expires", id),
  }
  assertDates(exception, today)
  return exception
}

function requiredText(raw: Record<string, unknown>, field: string, id: string): string {
  const value = raw[field]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`audit exception ${id}: "${field}" is required`)
  }
  return value.trim()
}

function assertDates(exception: AuditException, today: Date): void {
  const added = utcDay(exception.added, exception.id)
  const expires = utcDay(exception.expires, exception.id)
  if ((expires - added) / DAY_MS > MAX_AUDIT_EXCEPTION_DAYS) {
    throw new Error(`audit exception ${exception.id}: expiry is more than ${MAX_AUDIT_EXCEPTION_DAYS} days after it was added`)
  }
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  if (todayDay > expires) {
    throw new Error(`audit exception ${exception.id}: expired on ${exception.expires}; re-check the advisory and renew or remove it`)
  }
}

function utcDay(value: string, id: string): number {
  const time = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN
  if (Number.isNaN(time)) throw new Error(`audit exception ${id}: "${value}" is not a YYYY-MM-DD date`)
  return time
}

function assertUniqueIds(exceptions: readonly AuditException[]): void {
  const ids = exceptions.map((exception) => exception.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) throw new Error(`audit exception ${duplicate}: duplicate id`)
}
