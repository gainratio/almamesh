/**
 * FloatingChatPanel - Collapsible floating chat interface
 *
 * Renders as a small icon button in the bottom-right corner when closed.
 * Supports three size states:
 * - closed: Shows only a floating button
 * - minimized: Shows only the header bar
 * - normal: Shows 400px width panel with full chat
 * - maximized: Shows larger panel (700px, or near full-screen on mobile)
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatTurn } from '@almamesh/llm';
import { ChatPanel } from './ChatPanel';
import type { SSEMetaData } from '../../../lib/streaming';
import type { ViewMode } from '../../../lib/types';

type PanelState = 'closed' | 'minimized' | 'normal' | 'maximized';

interface FloatingChatPanelProps {
  personName: string;
  /** The active profile whose persisted conversation is loaded. */
  profileId: string | null;
  /** The chart this conversation is opened from (links a fresh thread). */
  chartId: string | null;
  viewMode: ViewMode;
  onAskQuestionStream: (
    question: string,
    onToken: (token: string) => void,
    onMeta: (meta: SSEMetaData) => void,
    viewMode?: ViewMode,
    history?: readonly ChatTurn[],
    retrievedContext?: readonly string[],
    onAgentStatus?: (label: string | null) => void,
  ) => Promise<{
    answer: string;
    timing_guidance?: string | null;
    remedies?: string[] | null;
  }>;
  /** Start with the panel open (e.g. arriving via a "discuss in chat" link). */
  initialOpen?: boolean;
}

// Icons as separate components for cleaner code
function ChatIcon() {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export function FloatingChatPanel({
  personName,
  profileId,
  chartId,
  viewMode,
  onAskQuestionStream,
  initialOpen = false,
}: FloatingChatPanelProps) {
  const { t } = useTranslation('chat');
  const [panelState, setPanelState] = useState<PanelState>(initialOpen ? 'normal' : 'closed');

  // Get width class based on panel state
  const getWidthClass = () => {
    switch (panelState) {
      case 'minimized':
        return 'w-[320px] sm:w-[400px]';
      case 'normal':
        return 'w-[320px] sm:w-[400px]';
      case 'maximized':
        return 'w-[calc(100vw-2rem)] sm:w-[600px] md:w-[700px] lg:w-[800px]';
      default:
        return '';
    }
  };

  // Get height class based on panel state
  const getHeightClass = () => {
    switch (panelState) {
      case 'maximized':
        return 'max-h-[calc(100vh-6rem)]';
      default:
        return '';
    }
  };

  // Handle header bar click to restore from minimized
  const handleHeaderClick = () => {
    if (panelState === 'minimized') {
      setPanelState('normal');
    }
  };

  // Control button component
  const ControlButton = ({
    onClick,
    ariaLabel,
    children,
    testId,
  }: {
    onClick: () => void;
    ariaLabel: string;
    children: React.ReactNode;
    testId?: string;
  }) => (
    <button
      onClick={onClick}
      className="flex items-center justify-center w-7 h-7 text-text-secondary hover:text-text-primary hover:bg-background-tertiary rounded-sm transition-colors"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </button>
  );

  return (
    <>
      {/* Floating Chat Button - shown when closed */}
      {panelState === 'closed' && (
        <button
          onClick={() => setPanelState('normal')}
          className="fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 bg-accent-gold text-background-primary rounded-full shadow-lg hover:bg-accent-gold/90 transition-all hover:scale-105 group"
          aria-label={t('controls.open')}
          data-testid="floating-chat-button"
        >
          <ChatIcon />
          {/* Tooltip */}
          <span className="absolute right-full mr-3 px-3 py-1.5 bg-background-secondary text-text-primary text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-ui-border">
            {t('tooltip')}
          </span>
        </button>
      )}

      {/* Chat Panel - shown when not closed */}
      {panelState !== 'closed' && (
        <div
          className={`fixed bottom-6 right-6 z-50 ${getWidthClass()} max-w-[calc(100vw-3rem)] animate-in slide-in-from-bottom-4 fade-in duration-200 transition-all ${getHeightClass()}`}
        >
          {/* Panel container with shadow */}
          <div className="shadow-2xl rounded-xl overflow-hidden bg-background-secondary border border-ui-border flex flex-col h-full">
            {/* Header bar */}
            <div
              className={`flex items-center justify-between px-4 py-3 bg-background-tertiary border-b border-ui-border ${
                panelState === 'minimized' ? 'cursor-pointer hover:bg-background-secondary' : ''
              }`}
              onClick={handleHeaderClick}
            >
              {/* Title with chat icon */}
              <div className="flex items-center gap-2">
                <span className="text-accent-gold">
                  <ChatIcon />
                </span>
                <h3 className="text-text-primary font-medium text-sm">{t('title')}</h3>
              </div>

              {/* Control buttons */}
              <div className="flex items-center gap-1">
                {/* Minimize button - shown when normal or maximized */}
                {(panelState === 'normal' || panelState === 'maximized') && (
                  <ControlButton
                    onClick={() => setPanelState('minimized')}
                    ariaLabel={t('controls.minimize')}
                    testId="floating-chat-minimize"
                  >
                    <MinimizeIcon />
                  </ControlButton>
                )}

                {/* Maximize button - shown when normal or minimized */}
                {(panelState === 'normal' || panelState === 'minimized') && (
                  <ControlButton
                    onClick={() => setPanelState('maximized')}
                    ariaLabel={t('controls.maximize')}
                    testId="floating-chat-maximize"
                  >
                    <MaximizeIcon />
                  </ControlButton>
                )}

                {/* Restore button - shown when maximized */}
                {panelState === 'maximized' && (
                  <ControlButton
                    onClick={() => setPanelState('normal')}
                    ariaLabel={t('controls.restore')}
                    testId="floating-chat-restore"
                  >
                    <RestoreIcon />
                  </ControlButton>
                )}

                {/* Close button - always shown */}
                <ControlButton
                  onClick={() => setPanelState('closed')}
                  ariaLabel={t('controls.close')}
                  testId="floating-chat-close"
                >
                  <CloseIcon />
                </ControlButton>
              </div>
            </div>

            {/* Chat content - hidden when minimized */}
            {panelState !== 'minimized' && (
              <div className={`flex-1 overflow-hidden ${panelState === 'maximized' ? 'h-[calc(100vh-10rem)]' : ''}`}>
                <ChatPanel
                  personName={personName}
                  profileId={profileId}
                  chartId={chartId}
                  viewMode={viewMode}
                  onAskQuestionStream={onAskQuestionStream}
                  hideHeader
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Backdrop for mobile when maximized */}
      {panelState === 'maximized' && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-xs lg:bg-black/20"
          onClick={() => setPanelState('normal')}
          aria-hidden="true"
        />
      )}
    </>
  );
}

export default FloatingChatPanel;
