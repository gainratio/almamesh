/**
 * SuggestedQuestions - Quick question suggestions carousel
 *
 * Displays horizontally scrolling suggested questions
 * for quick conversation starters.
 */

import { useTranslation } from 'react-i18next';

interface SuggestedQuestionsProps {
  onSelect: (question: string) => void;
  disabled?: boolean;
}

/** The suggestion catalog — keys map to `chat:suggested.questions.*`. */
const SUGGESTED_QUESTION_KEYS = [
  'career',
  'relationship',
  'year',
  'health',
  'spiritual',
  'timing',
  'finance',
  'lifepath',
] as const;

export function SuggestedQuestions({
  onSelect,
  disabled = false,
}: SuggestedQuestionsProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="mb-4">
      <p className="text-text-muted text-xs mb-2">{t('suggested.label')}</p>
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-ui-border scrollbar-track-transparent">
        {SUGGESTED_QUESTION_KEYS.map((key) => {
          const question = t(`suggested.questions.${key}`);
          return (
            <button
              key={key}
              onClick={() => onSelect(question)}
              disabled={disabled}
              className="shrink-0 px-3 py-2 bg-background-tertiary border border-ui-border rounded-full text-xs text-text-secondary hover:bg-background-secondary hover:border-accent-gold hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {question}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default SuggestedQuestions;
