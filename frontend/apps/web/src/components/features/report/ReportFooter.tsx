/**
 * ReportFooter — small per-report attribution at the foot of the document.
 *
 * Names the ayanamsa (calculation provenance) and the person the report is for.
 * Page numbers are handled by the print stylesheet's `@page` counters, not here.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ayanamsaDisplayName } from '../../../lib/reportData';

interface ReportFooterProps {
  readonly personName: string;
  /** Stamped snapshot ayanamsa convention (defaults to Lahiri when absent). */
  readonly ayanamsa?: string;
}

/** Attribution footer: ayanamsa provenance + the subject's name. */
export function ReportFooter({ personName, ayanamsa }: ReportFooterProps): ReactElement {
  const { t } = useTranslation(['report', 'settings']);
  const ayanamsaCode = (ayanamsa ?? 'LAHIRI').toUpperCase();
  const provenance =
    ayanamsaCode === 'LAHIRI'
      ? t('report:footer.provenance')
      : `${t(`settings:ayanamsa.${ayanamsaCode.toLowerCase()}`, {
          defaultValue: ayanamsaDisplayName(ayanamsaCode),
        })} · AlmaMesh`;
  return (
    <footer className="report-footer" data-testid="report-footer">
      <span>{provenance}</span>
      <span className="report-footer-name">{personName}</span>
    </footer>
  );
}
