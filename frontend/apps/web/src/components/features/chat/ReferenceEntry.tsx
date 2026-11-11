/**
 * ReferenceEntry - Document-style message component for Astrologer mode
 *
 * Displays messages in a professional, reference-like format without
 * the casual chat bubble aesthetics. Used in "Astrologer" (technical) mode
 * for a more professional, document-like experience.
 */

import { useTranslation } from 'react-i18next';
import { formatDisplayTime } from '../../../lib/dates';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { CopyMessageButton } from './CopyMessageButton';

interface ReferenceEntryProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  timing?: string | null;
  remedies?: string[] | null;
}

export function ReferenceEntry({
  role,
  content,
  timestamp,
  timing,
  remedies,
}: ReferenceEntryProps) {
  const { t } = useTranslation('chat');
  const isUser = role === 'user';

  return (
    <div
      className="mb-6 animate-in fade-in duration-200"
      data-testid={`reference-entry-${role}`}
    >
      {/* User query - styled as a question header */}
      {isUser ? (
        <div className="border-l-2 border-accent-gold pl-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-accent-gold uppercase tracking-wide">
              {t('reference.query')}
            </span>
            {timestamp && (
              <span className="text-xs text-text-muted">
                {formatDisplayTime(new Date(timestamp), {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
          <p className="text-text-primary font-medium text-sm leading-relaxed">
            {content}
          </p>
        </div>
      ) : (
        /* Assistant response - styled as a reference document */
        <div className="bg-background-tertiary/50 border border-ui-border/50 rounded-lg p-4">
          {/* Response header */}
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-ui-border/30">
            <svg
              className="w-4 h-4 text-accent-purple"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span className="text-xs font-medium text-accent-purple uppercase tracking-wide">
              {t('reference.analysis')}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {timestamp && (
                <span className="text-xs text-text-muted">
                  {formatDisplayTime(new Date(timestamp), {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
              <CopyMessageButton text={content} />
            </div>
          </div>

          {/* Main content - markdown with technical styling */}
          <div className="text-text-secondary">
            <MarkdownContent content={content} compact />
          </div>

          {/* Timing guidance section */}
          {timing && (
            <div className="mt-4 pt-3 border-t border-ui-border/30">
              <div className="flex items-center gap-2 mb-2">
                <svg
                  className="w-4 h-4 text-accent-blue"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="text-xs font-medium text-accent-blue uppercase tracking-wide">
                  {t('reference.timing_analysis')}
                </span>
              </div>
              <MarkdownContent content={timing} compact className="text-xs" />
            </div>
          )}

          {/* Remedies section */}
          {remedies && remedies.length > 0 && (
            <div className="mt-4 pt-3 border-t border-ui-border/30">
              <div className="flex items-center gap-2 mb-2">
                <svg
                  className="w-4 h-4 text-status-success"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="text-xs font-medium text-status-success uppercase tracking-wide">
                  {t('reference.recommended_remedies')}
                </span>
              </div>
              <ul className="space-y-1.5">
                {remedies.map((remedy, index) => (
                  <li
                    key={index}
                    className="text-xs text-text-muted flex items-start gap-2 pl-1"
                  >
                    <span className="text-accent-gold font-mono">{index + 1}.</span>
                    <span>{remedy}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ReferenceEntry;
