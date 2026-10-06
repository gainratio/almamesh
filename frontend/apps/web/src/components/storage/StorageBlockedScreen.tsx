import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { detectStorageBrowser } from './detectStorageBrowser';
import { BROWSER_STEPS, type BrowserSteps } from './storageSteps';
import { StorageSwitchArt } from './StorageSwitchArt';
import type { StorageRecheck } from './useStorageRecheck';

export type StorageBlockReason = 'site-storage-blocked' | 'storage-blocked' | 'database-unavailable';

function useFocusOnMount(): RefObject<HTMLHeadingElement | null> {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

interface PanelProps {
  readonly reason: StorageBlockReason;
  readonly children: ReactNode;
}

function Panel({ reason, children }: PanelProps) {
  return (
    <div className="flex justify-center px-4 py-12 sm:py-16">
      <section
        role="alert"
        data-testid="storage-blocked-notice"
        data-reason={reason}
        className="w-full max-w-xl rounded-xl border border-ui-border bg-background-secondary p-6 text-left shadow-lg sm:p-8"
      >
        {children}
      </section>
    </div>
  );
}

interface HeadlineProps {
  readonly children: ReactNode;
}

function Headline({ children }: HeadlineProps) {
  const ref = useFocusOnMount();
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className="font-display text-2xl leading-tight text-text-primary outline-none sm:text-[1.75rem]"
    >
      {children}
    </h1>
  );
}

/** The runtime cannot host SQLite at all: nothing to switch on, so no steps. */
export function DatabaseUnavailableCard() {
  const { t } = useTranslation();
  return (
    <Panel reason="database-unavailable">
      <Headline>{t('storage_unavailable.title')}</Headline>
      <p className="mt-3 text-text-body">{t('storage_unavailable.body')}</p>
      <p className="mt-3 text-text-secondary">{t('storage_unavailable.fix')}</p>
    </Panel>
  );
}

interface StepsProps {
  readonly browser: string;
  readonly steps: BrowserSteps;
}

function Steps({ browser, steps }: StepsProps) {
  const { t } = useTranslation();
  return (
    <ol data-testid="storage-steps" data-browser={browser} className="mt-4 space-y-3">
      {steps.steps.map((step, index) => (
        <li key={step} className="flex gap-3 text-text-body">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent-gold/60 font-display text-sm text-accent-gold"
          >
            {index + 1}
          </span>
          <span>{t(`storage_blocked.steps.${steps.key}.${step}`)}</span>
        </li>
      ))}
    </ol>
  );
}

interface RecheckProps {
  readonly recheck: StorageRecheck;
}

function Actions({ recheck }: RecheckProps) {
  const { t } = useTranslation();
  const checking = recheck.status === 'checking';
  return (
    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
      <Button
        data-testid="storage-allow-button"
        size="lg"
        disabled={checking}
        aria-busy={checking}
        onClick={() => void recheck.allowStorage()}
      >
        {t('storage_blocked.allow')}
      </Button>
      <Button
        data-testid="storage-check-again-button"
        variant="secondary"
        size="lg"
        disabled={checking}
        aria-busy={checking}
        onClick={() => void recheck.checkAgain()}
      >
        {checking ? t('storage_blocked.checking') : t('storage_blocked.check_again')}
      </Button>
    </div>
  );
}

function CheckResult({ recheck }: RecheckProps) {
  const { t } = useTranslation();
  return (
    <p role="status" className="mt-4 min-h-[1.5rem] text-sm">
      {recheck.status === 'still-blocked' ? (
        <span data-testid="storage-still-blocked" className="text-status-warning">
          {t('storage_blocked.still_blocked')}
        </span>
      ) : null}
    </p>
  );
}

interface StorageBlockedScreenProps {
  readonly reason: Exclude<StorageBlockReason, 'database-unavailable'>;
  readonly recheck: StorageRecheck;
}

/**
 * AlmaMesh runs only on persistent on-device SQLite. When the browser refuses
 * that storage, this screen says so and walks through allowing it for the
 * browser in use. It cannot open browser settings (no web page can).
 */
export function StorageBlockedScreen({ reason, recheck }: StorageBlockedScreenProps) {
  const { t } = useTranslation();
  const [browser] = useState(() => detectStorageBrowser(typeof navigator === 'undefined' ? undefined : navigator));
  const steps = BROWSER_STEPS[browser];
  const setting = t(`storage_blocked.illustration.${steps.setting}`);
  const state = t(steps.art === 'toggle-on' ? 'storage_blocked.illustration.on' : 'storage_blocked.illustration.off');
  return (
    <Panel reason={reason}>
      <Headline>{t('storage_blocked.title')}</Headline>
      <p className="mt-3 text-text-body">{t('storage_blocked.body')}</p>
      <p className="mt-2 text-sm text-text-secondary">{t('storage_blocked.reassure')}</p>
      <h2 className="mt-6 font-display text-lg text-text-primary">
        {t('storage_blocked.steps_title', { browser: t(`storage_blocked.browser.${steps.key}`) })}
      </h2>
      <p className="mt-1 text-sm text-text-muted">{t('storage_blocked.no_settings_link')}</p>
      <Steps browser={browser} steps={steps} />
      <div className="mt-5">
        <StorageSwitchArt
          art={steps.art}
          setting={setting}
          label={t('storage_blocked.illustration.label', { setting, state })}
        />
      </div>
      <Actions recheck={recheck} />
      <CheckResult recheck={recheck} />
    </Panel>
  );
}
