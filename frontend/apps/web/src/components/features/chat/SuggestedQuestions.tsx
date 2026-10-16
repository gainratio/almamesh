/**
 * SuggestedQuestions - Quick question suggestions carousel
 *
 * Displays horizontally scrolling suggested questions
 * for quick conversation starters.
 */

import { ThreadPrimitive } from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import type { PinRelative } from '@almamesh/llm';

interface SuggestedQuestionsProps {
  onSelect: (question: string) => void;
  disabled?: boolean;
  /** Where the pinned period sits against today; absent for a normal thread. */
  relative?: PinRelative;
  /**
   * With AI on, a starter is assistant-ui's ThreadPrimitive.Suggestion (it sends
   * through the runtime). With AI off it routes to `onSelect` (Connect AI).
   */
  aiConfigured?: boolean;
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
  aiConfigured = false,
}: SuggestedQuestionsProps) {
  const { t } = useTranslation('chat');
  const keys = relative === 'past' || relative === 'future'
    ? PINNED_STARTER_KEYS[relative]
    : SUGGESTED_QUESTION_KEYS.map((key) => `suggested.questions.${key}`);

  return (
    <div className="mb-4">
      <p className="text-text-muted text-xs mb-2">{t('suggested.label')}</p>
      <div className="flex flex-wrap gap-2 pb-2">
        {keys.map((key) => {
          const question = t(key);
          const className = "max-w-full px-3 py-2 text-left bg-background-tertiary border border-ui-border rounded-full text-xs text-text-secondary hover:bg-background-secondary hover:border-accent-gold hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
          return aiConfigured ? (
            <ThreadPrimitive.Suggestion key={key} prompt={question} send disabled={disabled} className={className} data-testid="chat-suggestion">
              {question}
            </ThreadPrimitive.Suggestion>
          ) : (
            <button key={key} type="button" onClick={() => onSelect(question)} disabled={disabled} className={className} data-testid="chat-suggestion">
              {question}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default SuggestedQuestions;
