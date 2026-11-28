/**
 * `SubperiodGuideBlock` — renders a Vimśottarī sub-period's plain-language or
 * technical meaning paragraph plus structured bullet points of key themes and
 * dated sky aspects inside that sub-period.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../ui/cn';
import type { SubperiodGuide } from '../../../lib/subperiodGuide';

export interface SubperiodGuideBlockProps {
  readonly guide: SubperiodGuide;
  readonly testid: string;
  readonly kicker?: string;
  readonly className?: string;
}

export function SubperiodGuideBlock({
  guide,
  testid,
  kicker,
  className,
}: SubperiodGuideBlockProps): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <div
      data-testid={testid}
      className={cn(
        'space-y-2.5 rounded-lg border border-ui-border/50 bg-background-secondary/40 px-3.5 py-3 text-sm',
        className,
      )}
    >
      {kicker && (
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-tertiary">
          {kicker}
        </p>
      )}
      <p className="leading-relaxed text-text-primary">{guide.meaning}</p>
      {guide.bullets.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-accent-gold/90">
            {t('subperiod.bullets_heading')}
          </p>
          <ul className="space-y-1.5 text-xs leading-relaxed text-text-secondary">
            {guide.bullets.map((bullet, index) => (
              <li key={`${testid}-b-${index}`} className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-gold/80" />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
