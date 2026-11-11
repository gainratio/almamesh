/**
 * MessageBubble - Individual chat message component
 *
 * Displays user or assistant messages with role-based styling.
 * Supports timing guidance and remedies sections for assistant responses.
 * Shows layman content by default with optional technical details toggle.
 *
 * In "For You" (layman) mode, uses warm conversational bubble styling.
 * In "Astrologer" (technical) mode, this component should not be used -
 * use ReferenceEntry instead for document-style formatting.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayTime } from '../../../lib/dates';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { CopyMessageButton } from './CopyMessageButton';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  timing?: string | null;
  remedies?: string[] | null;
  /** Optional technical content - if present, a toggle is shown */
  technicalContent?: string | null;
}

export function MessageBubble({
  role,
  content,
  timestamp,
  timing,
  remedies,
  technicalContent,
}: MessageBubbleProps) {
  const { t } = useTranslation('chat');
  const isUser = role === 'user';
  const [showTechnical, setShowTechnical] = useState(false);

  // Determine which content to display
  const hasTechnical = technicalContent && technicalContent.trim().length > 0;
  const displayContent = showTechnical && hasTechnical ? technicalContent : content;

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 animate-in slide-in-from-bottom-2 fade-in duration-200`}
      data-testid={`chat-message-${role}`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-accent-gold text-background-primary rounded-br-sm'
            : 'bg-background-tertiary text-text-secondary rounded-bl-sm'
        }`}
      >
        {/* Technical toggle for assistant messages with dual content */}
        {!isUser && hasTechnical && (
          <button
            onClick={() => setShowTechnical(!showTechnical)}
            className="text-xs text-accent-purple hover:text-accent-purple/80 transition-colors mb-2 flex items-center gap-1"
            data-testid="technical-toggle"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showTechnical ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {showTechnical ? t('bubble.show_simplified') : t('bubble.show_technical')}
          </button>
        )}

        {/* Main content */}
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{displayContent}</p>
        ) : (
          <MarkdownContent content={displayContent} compact />
        )}

        {/* Timing guidance (assistant only) */}
        {!isUser && timing && (
          <div className="mt-3 pt-3 border-t border-ui-border/30">
            <h4 className="text-xs font-semibold text-accent-purple mb-1">
              {t('bubble.timing_guidance')}
            </h4>
            <MarkdownContent content={timing} compact className="text-xs" />
          </div>
        )}

        {/* Remedies (assistant only) */}
        {!isUser && remedies && remedies.length > 0 && (
          <div className="mt-3 pt-3 border-t border-ui-border/30">
            <h4 className="text-xs font-semibold text-accent-blue mb-2">
              {t('bubble.suggested_remedies')}
            </h4>
            <ul className="space-y-1">
              {remedies.map((remedy, index) => (
                <li key={index} className="text-xs text-text-muted flex items-start gap-2">
                  <span className="text-accent-gold">*</span>
                  <span>{remedy}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Timestamp + Copy action */}
        {(timestamp || !isUser) && (
          <div className="mt-2 flex items-center justify-between gap-2">
            {timestamp ? (
              <p
                className={`text-xs ${
                  isUser ? 'text-background-primary/60' : 'text-text-muted'
                }`}
              >
                {formatDisplayTime(new Date(timestamp), {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            ) : (
              <span />
            )}
            {!isUser && <CopyMessageButton text={displayContent} />}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageBubble;
