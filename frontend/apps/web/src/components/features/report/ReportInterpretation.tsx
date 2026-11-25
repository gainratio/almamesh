/**
 * ReportInterpretation — the single-column written reading, SELECTED MODE ONLY.
 *
 * Renders exactly one voice (`layman` for "you", `technical` for "astrologer"),
 * never both stacked in one column the way the old export did. Order mirrors the
 * predecessor template's "Part 2": summary → strengths → challenges → life
 * themes → the life-area guidance sections (health … remedial). Each titled
 * block and each guidance section is dropped cleanly when its text is empty.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TitledPersona, VedicInterpretation } from '@almamesh/shared-types';
import {
  buildGuidanceSections,
  formatReportPersonaText,
  personaText,
  type ReportAudience,
} from '../../../lib/reportSelectors';
import { ReportProse } from './ReportProse';
import { ReportSectionHeading } from './ReportSectionHeading';
import { sectionNumeral } from '../../../lib/reportSections';

/** A list of titled personas (strengths / challenges / life themes) for one mode. */
function TitledBlock({
  title,
  items,
  audience,
  unavailableNotice,
  testid,
}: {
  title: string;
  items: readonly TitledPersona[];
  audience: ReportAudience;
  unavailableNotice: string;
  testid: string;
}): ReactElement | null {
  const resolved = items
    .map((item) => ({
      title: item.title ?? '',
      text: formatReportPersonaText(personaText(item, audience), unavailableNotice),
    }))
    .filter((item) => item.text.length > 0);

  if (resolved.length === 0) {
    return null;
  }

  // The block wrapper does NOT avoid breaking: a long Strengths/Challenges
  // block must FLOW across the page boundary so it fills the page instead of
  // jumping wholesale to a fresh page and leaving the prior one near-empty.
  // Only the leaf `<li>` items keep `report-avoid-break` so a single titled
  // item is not split mid-sentence across two pages.
  return (
    <div className="report-interp-block" data-testid={testid}>
      <h3 className="report-subsection-title">{title}</h3>
      <ul className="report-titled-list">
        {resolved.map((item, index) => (
          <li key={`${item.title}-${index}`} className="report-titled-item report-avoid-break">
            {item.title ? <span className="report-titled-name">{item.title}</span> : null}
            <ReportProse text={item.text} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ReportInterpretationProps {
  readonly interpretation: VedicInterpretation;
  readonly audience: ReportAudience;
}

/** The written interpretation, single-column, in the selected audience's voice. */
export function ReportInterpretation({
  interpretation,
  audience,
}: ReportInterpretationProps): ReactElement {
  const { t } = useTranslation('report');
  const unavailable = t('interpretation.section_unavailable');
  const guidance = buildGuidanceSections(interpretation, audience);
  const summary = formatReportPersonaText(personaText(interpretation.summary, audience), unavailable);

  return (
    <section className="report-section report-interpretation" data-testid="report-interpretation">
      <ReportSectionHeading index={sectionNumeral('interpretation')} title={t('interpretation.heading')} />

      {summary ? (
        <div className="report-summary-quote report-avoid-break">
          <ReportProse text={summary} testid="report-summary" />
        </div>
      ) : null}

      {/* "What's Active Now & Next" (current_sky, Spec 065) — the predictive
          differentiator leads the reading, prominently placed right after the
          summary. Degrades gracefully: absent/empty on a natal-only reading
          (honesty fence: never invent timing) → simply not rendered. */}
      <TitledBlock
        title={t('interpretation.current_sky')}
        items={interpretation.current_sky ?? []}
        audience={audience}
        unavailableNotice={unavailable}
        testid="report-current-sky"
      />

      <TitledBlock
        title={t('interpretation.strengths')}
        items={interpretation.strengths}
        audience={audience}
        unavailableNotice={unavailable}
        testid="report-strengths"
      />
      <TitledBlock
        title={t('interpretation.challenges')}
        items={interpretation.challenges}
        audience={audience}
        unavailableNotice={unavailable}
        testid="report-challenges"
      />
      <TitledBlock
        title={t('interpretation.life_themes')}
        items={interpretation.life_themes}
        audience={audience}
        unavailableNotice={unavailable}
        testid="report-life-themes"
      />

      {guidance.map((section) => (
        <div
          key={section.key}
          className="report-interp-block"
          data-testid={`report-guidance-${section.key}`}
        >
          <h3 className="report-subsection-title">{section.title}</h3>
          <ReportProse text={formatReportPersonaText(section.text, unavailable)} />
        </div>
      ))}

      {/* The Road Ahead (upcoming_periods) — the sixth AI section: dated
          period windows as titled items, same grammar as the blocks above.
          Absent/empty on older stored readings → simply not rendered. */}
      <TitledBlock
        title={t('interpretation.road_ahead')}
        items={interpretation.upcoming_periods ?? []}
        audience={audience}
        unavailableNotice={unavailable}
        testid="report-road-ahead"
      />
    </section>
  );
}
