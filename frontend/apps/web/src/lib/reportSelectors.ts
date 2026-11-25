/**
 * Report selectors — pure presentation helpers for the print-first report.
 *
 * These map the dashboard's audience modes onto a single canonical
 * `ReportAudience` and resolve dual-mode `Persona` text down to the one string
 * the selected audience should read. They compute NO astrology — they only
 * choose which engine/LLM field to surface, fixing the old report's habit of
 * dumping BOTH layman and technical copy into one column.
 */

import { isReadingWithheldText } from '@almamesh/llm';
import type { Persona, VedicInterpretation } from '@almamesh/shared-types';

/** Default formal availability marker when a subsection's prose was withheld by the reflection check. */
export const DEFAULT_SECTION_UNAVAILABLE_NOTICE =
  'Reflective commentary unavailable for this subsection — withheld for non-reflective phrasing.';

/** Replace interactive `READING_WITHHELD` retry copy with a clean report availability notice. */
export function formatReportPersonaText(
  text: string,
  unavailableNotice: string = DEFAULT_SECTION_UNAVAILABLE_NOTICE,
): string {
  if (!text) return '';
  return isReadingWithheldText(text) ? unavailableNotice : text;
}

/** The two audiences a report can be rendered for. */
export type ReportAudience = 'you' | 'astrologer';

/**
 * Normalize any of the app's mode spellings to a canonical `ReportAudience`.
 *
 * FOUR independent two-value enums name the SAME "plain vs expert" axis across
 * layers — we MAP them at boundaries, we do NOT unify them:
 *   - ContentMode (`@almamesh/store`):      `layman`  | `technical`   (the Dashboard toggle)
 *   - ReportAudience (this file):           `you`     | `astrologer`  (the report/print voice)
 *   - web ViewMode (`apps/web/lib/types`):  `layman`  | `astrologer`  (chart view mode)
 *   - llm ViewMode (`@almamesh/llm`):       `layman`  | `expert`      (chat serialization voice)
 * This resolver folds the "expert" spellings (`astrologer`/`technical`/`expert`)
 * to `astrologer`; anything unrecognized (or absent) falls back to `you` — the
 * friendlier default.
 */
export function resolveReportAudience(raw: string | null | undefined): ReportAudience {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'astrologer' || normalized === 'technical' || normalized === 'expert') {
    return 'astrologer';
  }
  return 'you';
}

/**
 * Pick the single string a `Persona` should render for the given audience.
 * `astrologer` prefers the technical voice (falling back to layman so a missing
 * technical field never blanks the section); `you` prefers the layman voice.
 * Returns an empty string when the persona carries nothing, so callers can skip
 * empty sections with a simple truthiness check.
 */
export function personaText(
  persona: Persona | null | undefined,
  audience: ReportAudience,
): string {
  if (!persona) {
    return '';
  }
  const primary = audience === 'astrologer' ? persona.technical : persona.layman;
  const fallback = audience === 'astrologer' ? persona.layman : persona.technical;
  return (primary ?? fallback ?? '').trim();
}

/** One resolved guidance block: its display title + the audience's text. */
export interface ReportGuidanceSection {
  readonly key: string;
  readonly title: string;
  readonly text: string;
}

/**
 * Resolve the seven life-area guidance sections (plus remedial measures) into a
 * flat, ordered list carrying only the audience's text, with empty/absent
 * sections dropped so the report never renders a hollow heading or a blank page.
 * Order mirrors the predecessor template's "Part 2".
 */
export function buildGuidanceSections(
  interpretation: VedicInterpretation,
  audience: ReportAudience,
): readonly ReportGuidanceSection[] {
  const candidates: ReadonlyArray<{ key: string; title: string; persona: Persona | null | undefined }> = [
    { key: 'health', title: 'Health & Wellness', persona: interpretation.health_guidance },
    { key: 'relationship', title: 'Relationships & Connections', persona: interpretation.relationship_guidance },
    { key: 'career', title: 'Career & Professional Life', persona: interpretation.career_guidance },
    { key: 'education', title: 'Learning & Education', persona: interpretation.education_guidance },
    { key: 'finances', title: 'Finances & Money', persona: interpretation.finances_guidance },
    { key: 'spiritual', title: 'Spiritual Growth & Inner Development', persona: interpretation.spiritual_guidance },
    { key: 'life_evolution', title: 'Life Evolution', persona: interpretation.life_evolution_guidance },
    { key: 'remedial', title: 'Remedial Measures & Self-Care', persona: interpretation.remedial_measures },
  ];

  return candidates
    .map(({ key, title, persona }) => ({ key, title, text: personaText(persona, audience) }))
    .filter((section) => section.text.length > 0);
}
