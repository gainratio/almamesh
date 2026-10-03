/**
 * RegenerationConfirmModal Component
 *
 * A confirmation modal that warns the user about the implications of
 * regenerating their chart (token cost, clearing chat history, etc.).
 *
 * Features:
 * - Displays affected items (chart, interpretation)
 * - Shows estimated token cost
 * - Shows current token balance and projected balance
 * - Handles loading state during regeneration
 * - Closes on outside click or Escape key
 * - Animated entrance/exit with Framer Motion
 */

import { useEffect, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import type { RegenerationScope } from '@almamesh/store';
import { modalVariants, overlayVariants } from '@/animations/ui';

interface RegenerationConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  scope: RegenerationScope;
  estimatedCost: number;
  currentBalance?: number;
  isProcessing?: boolean;
  /**
   * Present only when the rectified time crosses a sign boundary: the rising
   * sign changes `from` -> `to` and every house shifts with it. When set, the
   * user must explicitly acknowledge that consequence before regenerating —
   * this is not a tweak, it is a different chart. Absent/null -> no extra gate.
   */
  signFlip?: { readonly from: string; readonly to: string } | null;
}

export function RegenerationConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  scope,
  estimatedCost,
  currentBalance = 0,
  isProcessing = false,
  signFlip = null,
}: RegenerationConfirmModalProps) {
  const { t } = useTranslation(['settings', 'common']);

  // A rising-sign flip demands an explicit "yes, I understand" before we
  // regenerate. The acknowledgement resets every time the modal (re)opens or the
  // flip itself changes, so a stale tick can never wave a new flip through.
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [isOpen, signFlip]);
  const needsAck = signFlip != null;
  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isProcessing) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isProcessing, onClose]);

  const handleBackdropClick = useCallback(() => {
    if (!isProcessing) {
      onClose();
    }
  }, [isProcessing, onClose]);

  const projectedBalance = Math.max(0, currentBalance - estimatedCost);
  const hasInsufficientTokens = currentBalance < estimatedCost;

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="regeneration-confirm-title"
        >
          {/* Backdrop */}
          <motion.div
            variants={overlayVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="absolute inset-0 bg-black/60"
            onClick={handleBackdropClick}
            aria-hidden="true"
          />

          {/* Modal Content */}
          <motion.div
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="relative w-full max-w-md mx-4 bg-background-secondary border border-ui-border rounded-lg shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="p-6 pb-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-status-warning/20 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-status-warning"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <h2 id="regeneration-confirm-title" className="text-xl font-semibold text-text-primary">
                  {t('regen_modal.title')}
                </h2>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 pb-4">
              <p className="text-text-secondary text-sm mb-4">{t('regen_modal.intro')}</p>

              <div className="bg-background-tertiary border border-ui-border rounded-lg p-4 mb-6">
                <h3 className="text-sm font-medium text-text-primary mb-3">{t('regen_modal.impact_title')}</h3>
                <ul className="space-y-2 text-text-secondary text-xs">
                  <li className="flex items-start gap-2">
                    <span className="text-accent-gold mt-0.5">*</span>
                    <span>
                      <strong>{t('regen_modal.impact_chart_label')}</strong>
                      {t('regen_modal.impact_chart_detail')}
                    </span>
                  </li>
                  {scope !== 'none' && (
                    <li className="flex items-start gap-2">
                      <span className="text-accent-gold mt-0.5">*</span>
                      <span>
                        <strong>{t('regen_modal.impact_interpretation_label')}</strong>
                        {t('regen_modal.impact_interpretation_detail')}
                      </span>
                    </li>
                  )}
                  <li className="flex items-start gap-2">
                    <span className="text-status-error mt-0.5">*</span>
                    <span>
                      <strong>{t('regen_modal.impact_chat_label')}</strong>
                      {t('regen_modal.impact_chat_detail')}
                    </span>
                  </li>
                </ul>
              </div>

              {/* Token Summary */}
              <div className="bg-background-primary border border-ui-border rounded-lg p-4 mb-2">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-text-muted text-xs">{t('regen_modal.estimated_cost')}</span>
                  <span className="text-text-primary font-bold text-sm">{t('regen_modal.tokens', { n: estimatedCost })}</span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-text-muted text-xs">{t('regen_modal.current_balance')}</span>
                  <span className="text-text-primary text-sm">{t('regen_modal.tokens', { n: currentBalance })}</span>
                </div>
                <div className="border-t border-ui-border my-2 pt-2 flex justify-between items-center">
                  <span className="text-text-muted text-xs">{t('regen_modal.balance_after')}</span>
                  <span className={`font-bold text-sm ${hasInsufficientTokens ? 'text-status-error' : 'text-text-primary'}`}>
                    {t('regen_modal.tokens', { n: projectedBalance })}
                  </span>
                </div>
              </div>

              {hasInsufficientTokens && (
                <div className="mt-2 p-3 bg-status-error/10 border border-status-error/30 rounded-md">
                  <p className="text-status-error text-xs">{t('regen_modal.insufficient')}</p>
                </div>
              )}

              {signFlip && (
                <label
                  data-testid="regen-flip-ack"
                  className="mt-2 flex cursor-pointer items-start gap-3 rounded-md border border-status-warning/40 bg-status-warning/10 p-3"
                >
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    disabled={isProcessing}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-status-warning"
                  />
                  <span className="text-xs leading-relaxed text-status-warning">
                    {t('regen_modal.flip_ack', { from: signFlip.from, to: signFlip.to })}
                  </span>
                </label>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-background-primary border-t border-ui-border flex gap-3">
              <button
                onClick={onClose}
                disabled={isProcessing}
                className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={onConfirm}
                disabled={isProcessing || hasInsufficientTokens || (needsAck && !acknowledged)}
                className="flex-1 px-4 py-2.5 bg-accent-gold text-background-primary rounded-md hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm font-bold"
              >
                {isProcessing ? (
                  <>
                    <svg
                      className="w-4 h-4 animate-spin text-background-primary"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    {t('regen_modal.processing')}
                  </>
                ) : (
                  t('regen_modal.confirm')
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default RegenerationConfirmModal;
