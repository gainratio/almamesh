/**
 * Durable per-profile context notes ("what AlmaMesh remembers across threads").
 *
 * Stored additively on `Profile.memoryFacts` inside `almamesh-profiles` (the
 * same canonical OPFS SQLite row as `currentPlace`), so notes travel with
 * encrypted backups, never create a separate store row, and vanish when a
 * profile is deleted or app data is reset.
 */

export const PROFILE_MEMORY_CATEGORIES = [
  'life',
  'career',
  'relationship',
  'preference',
  'milestone',
] as const;

export type ProfileMemoryCategory = (typeof PROFILE_MEMORY_CATEGORIES)[number];

export const MAX_PROFILE_MEMORY_FACTS = 15;
export const MAX_MEMORY_FACT_CHARS = 160;

export interface ProfileMemoryFact {
  readonly id: string;
  readonly text: string;
  readonly category: ProfileMemoryCategory;
  readonly createdAt: string;
}

export interface ProfileMemoryFactInput {
  readonly text: string;
  readonly category: ProfileMemoryCategory;
  readonly id?: string;
  readonly createdAt?: string;
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const COORD_PAIR_PATTERN = /-?\b\d{1,3}\.\d{2,}\s*[,/]\s*-?\d{1,3}\.\d{2,}\b/g;
const COORD_LABELED_PATTERN = /\b(?:lat(?:itude)?|lon(?:gitude)?)\s*[:=]?\s*-?\d{1,3}(?:\.\d+)?/gi;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]?\d{4}\b/g;

export function isProfileMemoryCategory(value: unknown): value is ProfileMemoryCategory {
  return typeof value === 'string' && (PROFILE_MEMORY_CATEGORIES as readonly string[]).includes(value);
}

function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? ' ' : input[i];
  }
  return out;
}

/** Strip emails, phone numbers, and coordinates; collapse whitespace and cap length. */
export function sanitizeMemoryFactText(raw: string): string {
  const cleaned = stripControlChars(
    raw
      .replace(EMAIL_PATTERN, '')
      .replace(COORD_PAIR_PATTERN, '')
      .replace(COORD_LABELED_PATTERN, '')
      .replace(PHONE_PATTERN, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= MAX_MEMORY_FACT_CHARS ? cleaned : cleaned.slice(0, MAX_MEMORY_FACT_CHARS).trimEnd();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let memoryIdFallback = 0;
function nextMemoryId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  memoryIdFallback += 1;
  return `mem-${Date.now()}-${memoryIdFallback}`;
}

const EMPTY_MEMORY_FACTS: ProfileMemoryFact[] = [];
Object.freeze(EMPTY_MEMORY_FACTS);

function normalizeProfileMemoryFact(value: unknown): ProfileMemoryFact | undefined {
  if (!isPlainObject(value)) return undefined;
  const { id, text, category, createdAt } = value;
  if (typeof id !== 'string' || id.trim().length === 0) return undefined;
  if (typeof text !== 'string' || !isProfileMemoryCategory(category)) return undefined;
  if (typeof createdAt !== 'string' || createdAt.trim().length === 0) return undefined;
  const sanitized = sanitizeMemoryFactText(text);
  if (sanitized.length === 0) return undefined;
  if (
    id === id.trim() &&
    text === sanitized &&
    createdAt === createdAt.trim() &&
    Object.keys(value).length === 4
  ) {
    return value as unknown as ProfileMemoryFact;
  }
  return { id: id.trim(), text: sanitized, category, createdAt: createdAt.trim() };
}

/** Read validated memory facts off a profile, preserving identity when clean. */
export function getProfileMemoryFacts(
  profile: { readonly memoryFacts?: unknown } | undefined,
): ProfileMemoryFact[] {
  const raw = profile?.memoryFacts;
  if (!Array.isArray(raw) || raw.length === 0) return EMPTY_MEMORY_FACTS;
  const valid: ProfileMemoryFact[] = [];
  let unchanged = raw.length <= MAX_PROFILE_MEMORY_FACTS;
  for (const item of raw) {
    const normalized = normalizeProfileMemoryFact(item);
    if (normalized) {
      if (normalized !== item) unchanged = false;
      valid.push(normalized);
    } else {
      unchanged = false;
    }
  }
  if (valid.length === 0) return EMPTY_MEMORY_FACTS;
  if (unchanged) return raw as ProfileMemoryFact[];
  return valid.slice(-MAX_PROFILE_MEMORY_FACTS);
}

function dedupKey(text: string): string {
  return text.toLowerCase().replace(/[.!,?;:]+$/g, '').trim();
}

/** Insert or update a memory fact, deduplicating normalized text and capping at 15 items. */
export function upsertProfileMemoryFact(
  existing: readonly ProfileMemoryFact[],
  input: ProfileMemoryFactInput,
): { readonly facts: readonly ProfileMemoryFact[]; readonly fact: ProfileMemoryFact } | undefined {
  if (!isProfileMemoryCategory(input.category)) return undefined;
  const text = sanitizeMemoryFactText(input.text);
  if (text.length === 0) return undefined;
  const key = dedupKey(text);
  const prior = existing.find((item) => dedupKey(item.text) === key);
  const fact: ProfileMemoryFact = {
    id: prior?.id ?? (input.id?.trim() || nextMemoryId()),
    text,
    category: input.category,
    createdAt: input.createdAt?.trim() || new Date().toISOString(),
  };
  const withoutPrior = existing.filter((item) => item.id !== fact.id);
  const combined = [...withoutPrior, fact];
  const facts = combined.slice(-MAX_PROFILE_MEMORY_FACTS);
  return { facts, fact };
}
