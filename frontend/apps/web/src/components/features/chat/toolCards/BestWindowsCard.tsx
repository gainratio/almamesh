/**
 * Generative Muhurta / Timing Windows card for `find_best_windows`.
 */
import { useTranslation } from 'react-i18next';

interface WindowItem {
  readonly kind?: 'supportive' | 'challenging';
  readonly start?: string;
  readonly end?: string;
  readonly summary?: string;
}

interface BestWindowsPayload {
  readonly domain: string;
  readonly horizon_months: number;
  readonly domain_forecast?: {
    readonly score?: number;
    readonly supportive_windows?: readonly WindowItem[];
    readonly challenging_windows?: readonly WindowItem[];
  };
  readonly ashtakavarga?: {
    readonly sarva_total?: number;
    readonly strongest_signs?: readonly { readonly sign: string; readonly bindus: number }[];
  };
  readonly upcoming_dasha_shifts?: readonly { readonly lord: string; readonly start: string; readonly end: string }[];
}

function isBestWindowsPayload(value: unknown): value is BestWindowsPayload {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.domain === 'string' && typeof r.horizon_months === 'number';
}

function cap(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1).replace(/_/g, ' ') : '';
}

export function BestWindowsCard({ result }: { readonly result: unknown }) {
  const { t } = useTranslation('chat');
  if (!isBestWindowsPayload(result)) return null;

  const supportive = result.domain_forecast?.supportive_windows ?? [];
  const challenging = result.domain_forecast?.challenging_windows ?? [];
  const score = result.domain_forecast?.score;
  const topSigns = result.ashtakavarga?.strongest_signs ?? [];

  return (
    <section
      aria-label={t('cards.windows.title', { domain: cap(result.domain) })}
      data-testid="tool-card-best-windows"
      className="mb-2 rounded-xl border border-ui-border bg-background-secondary p-3 text-xs"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-text-primary">
          <span aria-hidden="true" className="text-accent-gold">✦</span>
          <span>{t('cards.windows.title', { domain: cap(result.domain) })}</span>
          <span className="rounded bg-background-tertiary px-1.5 py-0.5 text-[10px] font-normal text-text-muted">
            {t('cards.windows.horizon', { months: result.horizon_months })}
          </span>
        </div>
        {typeof score === 'number' && (
          <span className="rounded-full border border-accent-gold/40 bg-accent-gold/10 px-2 py-0.5 text-[11px] font-medium text-accent-gold">
            {t('cards.windows.strength', { score: Math.round(score) })}
          </span>
        )}
      </div>

      {supportive.length > 0 && (
        <div className="mb-2 space-y-1">
          <p className="text-[11px] font-medium text-status-success">
            <span aria-hidden="true">✦ </span>
            {t('cards.windows.supportive')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {supportive.slice(0, 4).map((w, idx) => (
              <span key={`${w.start ?? idx}`} className="rounded-lg border border-status-success/30 bg-status-success/5 px-2 py-1 text-[11px] text-text-primary">
                {w.start}{w.end && w.end !== w.start ? ` – ${w.end}` : ''}{w.summary ? ` · ${w.summary}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {challenging.length > 0 && (
        <div className="mb-2 space-y-1">
          <p className="text-[11px] font-medium text-accent-purple">
            <span aria-hidden="true">△ </span>
            {t('cards.windows.mindful')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {challenging.slice(0, 3).map((w, idx) => (
              <span key={`${w.start ?? idx}`} className="rounded-lg border border-accent-purple/30 bg-accent-purple/5 px-2 py-1 text-[11px] text-text-secondary">
                {w.start}{w.end && w.end !== w.start ? ` – ${w.end}` : ''}{w.summary ? ` · ${w.summary}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {topSigns.length > 0 && (
        <p className="text-[11px] text-text-muted">
          SAV: {topSigns.map((s) => `${cap(s.sign)} (${s.bindus})`).join(' · ')}
        </p>
      )}
    </section>
  );
}
