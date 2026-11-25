/**
 * ReportYogas — the integrated yoga narrative + the calculated yoga list.
 *
 * The narrative is the audience-resolved `integrated_yoga_narrative` persona
 * (LLM prose). The list is the engine's own formed yogas (calculation
 * integrity): the `display_name`, the qualitative grade as a small-caps
 * typographic mark (the engine's own word, mirrored — never re-derived), the short
 * description, and a one-line formation basis with its classical citation —
 * every word the engine's verbatim.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { YogaData } from '@almamesh/browser/types';
import type { VedicInterpretation } from '@almamesh/shared-types';
import {
  formatReportPersonaText,
  personaText,
  type ReportAudience,
} from '../../../lib/reportSelectors';
import { hasStrength, signedMark, yogaStrength } from '../../../lib/yogaStrength';
import { formatYogaActivation } from '../../../lib/yogaActivation';
import { yogaClaimId, type StabilityMarker } from '../../../lib/stability';
import { ReportProse } from './ReportProse';
import { ReportSectionHeading } from './ReportSectionHeading';
import { sectionNumeral } from '../../../lib/reportSections';
import { StabilityChip } from './StabilityChip';

const capitalize = (word: string): string =>
  word ? word.charAt(0).toUpperCase() + word.slice(1) : word;

/**
 * The calibrated STRUCTURAL strength mark: a "NN% · band" headline, a
 * "structural estimate" tier label, and the signed factor ledger — all
 * anchored to the engine's own marks (never a fabricated precision score).
 * Renders nothing for bundles stored before the calibrated-strength upgrade.
 *
 * The ledger always ends with the FULL achievable scale ("net +0 on the −3…+3
 * scale"), because that is the denominator the engine's percentage actually
 * divides by. Printing only the favorable bound made a correct 50% look like
 * arithmetic the reader could not reproduce.
 */
function YogaStrengthMark({ yoga }: { readonly yoga: YogaData }): ReactElement | null {
  const { t } = useTranslation('report');
  if (!hasStrength(yoga)) {
    return null;
  }
  const strength = yogaStrength(yoga);
  const band = t(`yogas.grade.${strength.band}`);
  const scale = t('yogas.strength.summary', {
    net: signedMark(strength.net),
    min: signedMark(strength.min),
    max: signedMark(strength.max),
  });
  return (
    <div className="report-yoga-strength" data-testid="report-yoga-strength">
      <span
        className="report-strength-pct"
        aria-label={t('yogas.strength.aria', { pct: strength.pct, band, scale })}
      >
        {strength.pct}%<span className="report-strength-band"> · {band}</span>
      </span>
      <span className="report-strength-tier">{t('yogas.strength.tier')}</span>
      <p className="report-strength-ledger">
        {strength.entries.map((entry, index) => (
          <span key={`${entry.planet}-${entry.value}-${index}`}>
            {index > 0 ? ' · ' : ''}
            {capitalize(entry.planet)} {entry.value} {signedMark(entry.mark)}
          </span>
        ))}
        {strength.entries.length > 0 ? ' → ' : ''}
        {scale}
      </p>
    </div>
  );
}

interface ReportYogasProps {
  readonly yogas: readonly YogaData[];
  /**
   * OPTIONAL: the LLM narrative. When the interpretation has not been generated
   * yet, the section degrades to the engine's deterministic formed-yoga registry
   * (no prose) rather than disappearing.
   */
  readonly interpretation?: VedicInterpretation;
  readonly audience: ReportAudience;
  /**
   * OPTIONAL per-claim birth-time-stability markers, keyed by `yoga:<name>`.
   * When present, each yoga shows whether its grade survives both candidate
   * ascendants (Stage-4 stable-vs-lagna). Absent for older stored payloads.
   */
  readonly stability?: ReadonlyMap<string, StabilityMarker>;
}

/** Yoga section: the narrative (if any) + the engine's formed-yoga registry. */
export function ReportYogas({
  yogas,
  interpretation,
  audience,
  stability,
}: ReportYogasProps): ReactElement | null {
  const { t } = useTranslation('report');
  const { t: tp } = useTranslation('predictive');
  const narrative = interpretation
    ? formatReportPersonaText(
        personaText(interpretation.integrated_yoga_narrative, audience),
        t('interpretation.section_unavailable'),
      )
    : '';

  if (!narrative && yogas.length === 0) {
    return null;
  }

  return (
    <section className="report-section" data-testid="report-yogas">
      <ReportSectionHeading index={sectionNumeral('yogas')} title={t('yogas.heading')} />

      {narrative ? (
        <ReportProse
          text={narrative}
          className="report-avoid-break"
          testid="report-yoga-narrative"
        />
      ) : null}

      {yogas.length > 0 ? (
        <ul className="report-yoga-list">
          {yogas.map((yoga) => {
            // The first formation rule is the engine's own one-line basis;
            // min-length-1 by schema, guarded for older stored payloads.
            const basis = yoga.formation_rules[0];
            return (
              <li
                key={`${yoga.name}-${yoga.planetary_signature}`}
                className="report-yoga-item report-avoid-break"
              >
                <div className="report-yoga-head">
                  <span className="report-yoga-name">{yoga.display_name || yoga.name}</span>
                  <span className="report-yoga-marks">
                    <span
                      className="report-yoga-grade"
                      aria-label={t('yogas.grade_aria', {
                        grade: t(`yogas.grade.${yoga.grade}`),
                      })}
                    >
                      {t(`yogas.grade.${yoga.grade}`)}
                    </span>
                    <StabilityChip marker={stability?.get(yogaClaimId(yoga.name))} />
                  </span>
                </div>
                <YogaStrengthMark yoga={yoga} />
                {yoga.dasha_activation ? (
                  <p className="report-strength-ledger" data-testid="report-yoga-activation">
                    {formatYogaActivation(yoga, t, tp)}
                  </p>
                ) : null}
                {yoga.description ? (
                  <p className="report-yoga-desc">{yoga.description}</p>
                ) : null}
                {basis ? (
                  <p className="report-yoga-basis">
                    {basis.description}
                    {' — '}
                    <cite className="report-yoga-source">{basis.source}</cite>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
