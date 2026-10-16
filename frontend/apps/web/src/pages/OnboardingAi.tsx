/**
 * OnboardingAiPage — `/onboarding/ai`, the step after the chart is saved.
 *
 * Shown only when no AI is set up: one line of context, a primary "Connect AI"
 * that opens the shared AI setup panel (the same one Settings renders), and a
 * small "Not now" link to the dashboard. A successful connection lands on the
 * dashboard. With AI already set up the step is skipped; with no chart there is
 * nothing to talk about yet, so it goes back to onboarding.
 *
 * `AI_SETUP_REQUIRED_IN_ONBOARDING` removes "Not now" (the one-line switch to
 * make the step mandatory).
 */

import type { ReactElement } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '../components/ui';
import { Logo } from '../components/ui/Logo';
import { ConnectAiButton, type ConnectAiButtonProps } from '../components/features/ai/AiSetupDialog';
import { useLlmStatus } from '../hooks/useLlmStatus';
import { useOnboardingStatus } from '../hooks/useOnboardingStatus';
import { AI_SETUP_REQUIRED_IN_ONBOARDING } from '../lib/onboardingAiStep';

export interface OnboardingAiPageProps {
  /** Hide "Not now". Defaults to the app-wide flag. */
  required?: boolean;
  /** The setup panel's network seams (tests only). */
  panel?: ConnectAiButtonProps['panel'];
}

export function OnboardingAiPage({
  required = AI_SETUP_REQUIRED_IN_ONBOARDING,
  panel,
}: OnboardingAiPageProps): ReactElement {
  const { t } = useTranslation('onboarding');
  const navigate = useNavigate();
  const { hasChart } = useOnboardingStatus();
  const aiConfigured = useLlmStatus().configured;

  if (!hasChart) return <Navigate to="/onboarding" replace />;
  if (aiConfigured) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-[calc(100dvh-var(--app-chrome-block))] flex flex-col bg-background-primary relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,130vw)] h-[min(600px,130vw)] bg-accent-purple/15 rounded-full blur-[120px]" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(400px,90vw)] h-[min(400px,90vw)] bg-accent-gold/8 rounded-full blur-[100px]" />
      </div>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-10 relative z-10">
        <section className="w-full max-w-md text-center" aria-labelledby="onboarding-ai-title" data-testid="onboarding-ai-step">
          <Logo size="hero" className="justify-center mb-6 sm:mb-8" />
          <h1 id="onboarding-ai-title" className="font-display text-2xl sm:text-3xl text-text-primary">
            {t('ai_step.title')}
          </h1>
          <p className="mt-3 text-text-secondary leading-relaxed" data-testid="onboarding-ai-body">
            {t('ai_step.body')}
          </p>

          <div className="mt-8 flex flex-col items-center gap-4">
            <ConnectAiButton
              label={t('ai_step.connect')}
              testId="onboarding-ai-connect"
              className={buttonVariants({ size: 'lg', className: 'min-w-[12rem]' })}
              autoFocus
              panel={panel}
              onConnected={() => navigate('/dashboard')}
            />
            {!required && (
              <Link
                to="/dashboard"
                className="rounded text-sm text-text-muted underline-offset-4 transition-colors hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-focus"
                data-testid="onboarding-ai-not-now"
              >
                {t('ai_step.not_now')}
              </Link>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default OnboardingAiPage;
