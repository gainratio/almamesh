/**
 * AiSetupDialog — the shared AI setup panel in a modal, so any surface that
 * needs AI (chat, the reading, a mesh reading, the onboarding AI step) can open
 * setup in place instead of sending the person away to Settings.
 *
 * It renders `AiSetupPanel` (the only AI setup UI in the app) without the
 * "AI off" choice: a person who opened it wants to connect. Storage, the
 * connection test and every panel guard are the panel's own; this file adds
 * only the modal and "close once connected".
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmStatus } from '@almamesh/llm';
import { Dialog } from '../../ui/Dialog';
import { AiSetupPanel, type AiSetupPanelProps } from './AiSetupPanel';

/** The panel's injectable seams (tests stub the network with these). */
type AiSetupSeams = Omit<AiSetupPanelProps, 'showOffChoice' | 'intro' | 'showTitle' | 'onConnected'>;

export interface AiSetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Runs after the key is saved and the connection test passed, before closing. */
  onConnected?: (status: LlmStatus) => void | Promise<void>;
  panel?: AiSetupSeams;
}

export function AiSetupDialog({ open, onClose, onConnected, panel }: AiSetupDialogProps): ReactElement {
  const { t } = useTranslation('common');
  const handleConnected = async (status: LlmStatus) => {
    await onConnected?.(status);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('ai_setup.dialog_title')}>
      <div data-testid="ai-setup-dialog">
        <AiSetupPanel {...panel} showOffChoice={false} showTitle={false} onConnected={handleConnected} />
      </div>
    </Dialog>
  );
}

export interface ConnectAiButtonProps {
  label: ReactNode;
  testId?: string;
  className?: string;
  /** Take focus on mount (a page whose main action this is). */
  autoFocus?: boolean;
  onConnected?: (status: LlmStatus) => void | Promise<void>;
  panel?: AiSetupSeams;
}

const DEFAULT_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-lg border border-accent-gold px-4 py-2 text-sm font-semibold text-accent-gold transition-colors hover:bg-accent-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60';

/** A button that opens `AiSetupDialog`. The one "set up AI" door for no-AI surfaces. */
export function ConnectAiButton({
  label,
  testId,
  className,
  autoFocus,
  onConnected,
  panel,
}: ConnectAiButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? DEFAULT_BUTTON_CLASS}
        data-testid={testId}
        aria-haspopup="dialog"
        autoFocus={autoFocus}
      >
        {label}
      </button>
      <AiSetupDialog open={open} onClose={() => setOpen(false)} onConnected={onConnected} panel={panel} />
    </>
  );
}
