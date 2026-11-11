/**
 * Quick-launch strip on the Dashboard that opens the Guide drawer with
 * specialist starter prompts (`?chat=open&ask=...`).
 *
 * Pure UI component (zero AI SDK / zod / assistant-ui imports) so the
 * Dashboard static bundle stays 100% lazy-chat-clean.
 */
import { useTranslation } from 'react-i18next';

interface ChatQuickLaunchStripProps {
  readonly onLaunchPrompt: (prompt: string) => void;
}

const QUICK_LAUNCH_KEYS = [
  { id: 'week', icon: '☀', labelKey: 'quick_launch.this_week_label', promptKey: 'suggested.questions.this_week' },
  { id: 'vargas', icon: '◈', labelKey: 'quick_launch.vargas_label', promptKey: 'suggested.questions.vargas' },
  { id: 'windows', icon: '✦', labelKey: 'quick_launch.windows_label', promptKey: 'suggested.questions.best_windows' },
] as const;

export function ChatQuickLaunchStrip({ onLaunchPrompt }: ChatQuickLaunchStripProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      data-testid="dashboard-guide-quick-launch"
      className="no-print flex flex-wrap items-center gap-2 rounded-xl border border-ui-border bg-background-secondary/60 px-4 py-2.5"
    >
      <span className="text-xs font-medium text-text-secondary">
        {t('quick_launch.heading')}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_LAUNCH_KEYS.map((item) => {
          const prompt = t(item.promptKey);
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`dashboard-guide-ask-${item.id}`}
              onClick={() => onLaunchPrompt(prompt)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-ui-border bg-background-primary px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent-gold hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
            >
              <span aria-hidden="true" className="text-accent-gold">{item.icon}</span>
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
