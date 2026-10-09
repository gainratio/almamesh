/**
 * SuggestedQuestions - Quick question suggestions carousel
 *
 * Displays horizontally scrolling suggested questions
 * for quick conversation starters.
 */

import { useTranslation } from 'react-i18next';
import type { PinRelative } from '@almamesh/llm';

interface SuggestedQuestionsProps {
  onSelect: (question: string) => void;
  disabled?: boolean;
  /** Where the pinned period sits against today; absent for a normal thread. */
  relative?: PinRelative;
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

/** Time travel starters by tense (spec Part 3); "contains_today" keeps the current set. */
const PINNED_STARTER_KEYS = {
  past: ['time_travel.starters.past.hard', 'time_travel.starters.past.teaching'],
  future: ['time_travel.starters.future.prepare', 'time_travel.starters.future.strongest'],
} as const;

export function SuggestedQuestions({
  onSelect,
  disabled = false,
  relative,
}: SuggestedQuestionsProps) {
  const { t } = useTranslation('chat');
  const keys = relative === 'past' || relative === 'future'
    ? PINNED_STARTER_KEYS[relative]
    : SUGGESTED_QUESTION_KEYS.map((key) => `suggested.questions.${key}`);

  return (
    <div className="mb-4">
      <p className="text-text-muted text-xs mb-2">{t('suggested.label')}</p>
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-ui-border scrollbar-track-transparent">
        {keys.map((key) => {
          const question = t(key);
          return (
            <button
              key={key}
              onClick={() => onSelect(question)}
              disabled={disabled}
              className="flex-shrink-0 px-3 py-2 bg-background-tertiary border border-ui-border rounded-full text-xs text-text-secondary hover:bg-background-secondary hover:border-accent-gold hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
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
