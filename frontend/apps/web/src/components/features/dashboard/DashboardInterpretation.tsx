/**
 * DashboardInterpretation — the FULL AI reading, dashboard-native.
 *
 * The dashboard used to surface only the reading's `summary`; the strengths,
 * challenges, themes, yogas, life-area guidance, remedies and upcoming periods
 * were export/report-only. This component brings them onto the dashboard with
 * PROGRESSIVE DISCLOSURE: the core narrative (strengths → challenges → life
 * themes) leads and is always visible, and the deeper reference material
 * (yogas, the seven life-area guidances, remedies, the road ahead) collapses
 * into accessible in-place disclosures, closed by default.
 *
 * It computes NO astrology and makes NO LLM call. It reuses the report layer's
 * pure selectors — `personaText` (voice resolution) and `buildGuidanceSections`
 * (the canonical guidance ordering + empty-dropping) — but renders with the
 * Observatory dark theme, never the light paper-report classes. The `audience`
 * prop (For You / For Astrologer) drives every section at the render boundary,
 * so toggling the voice re-renders instantly.
 */

import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TitledPersona, VedicInterpretation } from '@almamesh/shared-types';
import {
  buildGuidanceSections,
  formatReportPersonaText,
  personaText,
  type ReportAudience,
} from '../../../lib/reportSelectors';
import { Disclosure } from '../../ui/Disclosure';
import { MarkdownContent } from '../../ui/MarkdownContent';

interface ResolvedItem {
  readonly title: string;
  readonly text: string;
}

/** Resolve titled personas to `{title, text}`, dropping ones with empty text. */
function resolveTitledItems(
  items: readonly TitledPersona[],
  audience: ReportAudience,
  unavailableText: string,
): readonly ResolvedItem[] {
  return items
    .map((item) => ({
      title: item.title ?? '',
      text: formatReportPersonaText(personaText(item, audience), unavailableText),
    }))
    .filter((item) => item.text.length > 0);
}

/** A vertical stack of titled prose blocks (brass sub-title + reading). */
function TitledItems({
  items,
  fill = false,
}: {
  items: readonly ResolvedItem[];
  /** Let the prose fill its container width (used inside the bordered cards). */
  fill?: boolean;
}): ReactElement {
  return (
    <div className="space-y-5">
      {items.map((item, index) => (
        <div key={`${item.title}-${index}`}>
          {item.title ? (
            <h4 className="mb-1 font-display text-[0.95rem] font-medium text-accent-gold-bright">
              {item.title}
            </h4>
          ) : null}
          <MarkdownContent content={item.text} compact className={fill ? 'max-w-none' : undefined} />
        </div>
      ))}
    </div>
  );
}

/** One always-visible core-narrative group (Strengths / Challenges / Themes). */
function CoreGroup({
  title,
  items,
  testid,
}: {
  title: string;
  items: readonly ResolvedItem[];
  testid: string;
}): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <section className="space-y-4" data-testid={testid}>
      <h3 className="flex items-center gap-3 font-display text-lg text-text-primary">
        <span
          aria-hidden="true"
          className="h-px w-8 bg-gradient-to-r from-accent-gold/70 to-transparent"
        />
        {title}
      </h3>
      <TitledItems items={items} />
    </section>
  );
}

/** One collapsible reference section, closed by default, opened in place. */
function CollapsibleSection({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <div data-testid={testid}>
      <Disclosure
        summary={<span className="font-display text-base text-text-primary">{title}</span>}
        toggleLabel={t('interpretation.expand')}
        toggleLabelOpen={t('interpretation.collapse')}
        className="rounded-xl border border-ui-border bg-background-secondary/50 shadow-[inset_0_1px_0_0_rgba(244,241,232,0.04)] transition-colors hover:border-accent-gold/40 hover:bg-background-secondary/70"
        triggerClassName="px-5 py-[0.9rem]"
        contentClassName="mx-5 border-t border-ui-border/70 pb-5 pt-4"
      >
        {children}
      </Disclosure>
    </div>
  );
}

interface DashboardInterpretationProps {
  readonly interpretation: VedicInterpretation;
  readonly audience: ReportAudience;
}

/** The full reading on the dashboard: core narrative + collapsible depth. */
export function DashboardInterpretation({
  interpretation,
  audience,
}: DashboardInterpretationProps): ReactElement | null {
  const { t } = useTranslation(['dashboard', 'report']);
  const unavailableText = t('report:interpretation.section_unavailable');

  const strengths = resolveTitledItems(interpretation.strengths, audience, unavailableText);
  const challenges = resolveTitledItems(interpretation.challenges, audience, unavailableText);
  const themes = resolveTitledItems(interpretation.life_themes, audience, unavailableText);

  const yogaText = formatReportPersonaText(
    personaText(interpretation.integrated_yoga_narrative, audience),
    unavailableText,
  );
  const guidance = buildGuidanceSections(interpretation, audience).map((section) => ({
    ...section,
    text: formatReportPersonaText(section.text, unavailableText),
  }));

  const hasCore = strengths.length > 0 || challenges.length > 0 || themes.length > 0;
  const hasDepth = Boolean(yogaText) || guidance.length > 0;
  if (!hasCore && !hasDepth) {
    return null;
  }

  return (
    // One cohesive reading column: the open core narrative and the bordered
    // collapsibles share a measure so the section reads as a single article,
    // never a narrow prose column beside edge-to-edge bars.
    <div className="max-w-2xl space-y-8" data-testid="dashboard-interpretation">
      {hasCore ? (
        <div className="space-y-8">
          <CoreGroup
            title={t('interpretation.strengths')}
            items={strengths}
            testid="dashboard-strengths"
          />
          <CoreGroup
            title={t('interpretation.challenges')}
            items={challenges}
            testid="dashboard-challenges"
          />
          <CoreGroup
            title={t('interpretation.life_themes')}
            items={themes}
            testid="dashboard-life-themes"
          />
        </div>
      ) : null}

      {hasDepth ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-3 pb-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-text-muted">
              {t('interpretation.explore')}
            </span>
            <span
              aria-hidden="true"
              className="h-px flex-1 bg-gradient-to-r from-accent-gold/25 via-ui-border to-transparent"
            />
          </div>

          {yogaText ? (
            <CollapsibleSection title={t('interpretation.yogas')} testid="dashboard-yogas">
              <MarkdownContent content={yogaText} compact className="max-w-none" />
            </CollapsibleSection>
          ) : null}

          {guidance.map((section) => (
            <CollapsibleSection
              key={section.key}
              title={t(`interpretation.guidance.${section.key}`)}
              testid={`dashboard-guidance-${section.key}`}
            >
              <MarkdownContent content={section.text} compact className="max-w-none" />
            </CollapsibleSection>
          ))}

        </div>
      ) : null}
    </div>
  );
}

interface DashboardCurrentTimelineProps {
  readonly currentSky: readonly TitledPersona[];
  readonly upcomingPeriods: readonly TitledPersona[];
  readonly audience: ReportAudience;
  readonly caption?: string | null;
}

/** The independently generated, explicitly refreshed current-timing artifact. */
export function DashboardCurrentTimeline({
  currentSky,
  upcomingPeriods,
  audience,
  caption,
}: DashboardCurrentTimelineProps): ReactElement | null {
  const { t } = useTranslation(['dashboard', 'report']);
  const unavailableText = t('report:interpretation.section_unavailable');
  const resolvedSky = resolveTitledItems(currentSky, audience, unavailableText);
  const resolvedPeriods = resolveTitledItems(upcomingPeriods, audience, unavailableText);
  if (resolvedSky.length === 0 && resolvedPeriods.length === 0) return null;

  return (
    <section className="max-w-2xl space-y-5" data-testid="current-timeline-section">
      <header>
        <h2 className="font-display text-xl text-text-primary">
          {t('timeline.heading')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">{t('timeline.description')}</p>
      </header>
      <CoreGroup
        title={t('interpretation.current_sky')}
        items={resolvedSky}
        testid="dashboard-current-sky"
      />
      {resolvedPeriods.length > 0 ? (
        <CollapsibleSection
          title={t('interpretation.road_ahead')}
          testid="dashboard-road-ahead"
        >
          <TitledItems items={resolvedPeriods} fill />
        </CollapsibleSection>
      ) : null}
      {caption ? (
        <p
          className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary"
          data-testid="timeline-provenance"
        >
          {caption}
        </p>
      ) : null}
    </section>
  );
}
