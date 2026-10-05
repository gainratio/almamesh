import { Component, ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { safeError } from '@almamesh/shared-types';

import { resetAppData } from '../lib/resetAppData';
import { isRollbackRefusal, lastEngineBootFailure } from '../lib/engineLifecycle';
import { RollbackResetGuard } from './RollbackResetGuard';
import { incompleteDatabases, ResetIncompleteNotice } from './ResetIncompleteNotice';
import { isChunkLoadError } from '../lib/chunkError';
import { reloadForUpdate } from '../lib/swSelfHeal';

/** One automatic engine-preserving reload per session for a chunk failure. */
const EB_CHUNK_HEAL_KEY = 'almamesh:eb-chunk-heal';

interface OwnProps {
  children: ReactNode;
  fallback?: ReactNode;
}

type Props = OwnProps & WithTranslation;

interface State {
  hasError: boolean;
  error: Error | null;
  isChunkError: boolean;
  resetIncomplete?: readonly string[];
}

/**
 * Error Boundary component that catches JavaScript errors anywhere in the child
 * component tree, logs a privacy-safe diagnostic code, and displays a fallback UI.
 */
class ErrorBoundaryBase extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, isChunkError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, isChunkError: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Emit a stable code only: error messages and component props can contain
    // user data. Recovery behavior below provides the actionable signal.
    safeError('error_boundary.caught', { error, componentStack: errorInfo.componentStack });

    // A failed code-split import is a deploy/update artifact, not a crash. Heal
    // it automatically ONCE per session (unregister SW + drop the stale shell +
    // reload — engine data preserved). Guarded so a persistent fault can't loop;
    // after that the update card's manual reload button is the fallback.
    if (isChunkLoadError(error) && !this.chunkHealAttempted()) {
      this.markChunkHealAttempted();
      void reloadForUpdate();
    }
  }

  chunkHealAttempted(): boolean {
    try {
      return sessionStorage.getItem(EB_CHUNK_HEAL_KEY) === '1';
    } catch {
      return false;
    }
  }

  markChunkHealAttempted(): void {
    try {
      sessionStorage.setItem(EB_CHUNK_HEAL_KEY, '1');
    } catch {
      // Best-effort; a missing guard only risks one extra reload.
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, isChunkError: false });
  };

  handleReloadForUpdate = () => {
    void reloadForUpdate();
  };

  /**
   * The bulletproof escape hatch for a stranded returning visitor: wipe every
   * stale-state source (service worker, caches, localStorage, IndexedDB, and
   * the OPFS signed-bundle cache + its rollback floor) then reload into a clean
   * boot. Explicit click only. Best-effort cleanup never blocks the reload,
   * but a user database that could not be deleted stops it, visibly.
   */
  handleResetAppData = () => {
    this.setState({ resetIncomplete: undefined });
    void resetAppData().then(
      () => window.location.reload(),
      (error: unknown) => this.setState({ resetIncomplete: incompleteDatabases(error) }),
    );
  };

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // A failed chunk import means the app updated while this tab was open.
      // Present it as an update (not a crash) with a repair-reload that clears
      // the stale service worker; the engine data + saved charts are preserved.
      if (this.state.isChunkError) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-background-primary p-4">
            <div className="max-w-md w-full bg-background-secondary border border-ui-border rounded-xl shadow-lg p-6 text-center">
              <div className="text-4xl mb-4">
                <span role="img" aria-label={t('error_boundary.warning_aria')}>🔄</span>
              </div>
              <h1 className="text-xl font-semibold text-text-primary mb-2">
                {t('error_boundary.update_title')}
              </h1>
              <p className="text-text-secondary mb-6">{t('error_boundary.update_body')}</p>
              <button
                onClick={this.handleReloadForUpdate}
                className="px-4 py-2 rounded-lg bg-accent-gold text-background-darkest font-medium hover:bg-accent-gold-bright transition-colors"
              >
                {t('error_boundary.update_reload')}
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-background-primary p-4">
          <div className="max-w-md w-full bg-background-secondary border border-ui-border rounded-xl shadow-lg p-6 text-center">
            <div className="text-4xl mb-4">
              <span role="img" aria-label={t('error_boundary.warning_aria')}>⚠️</span>
            </div>
            <h1 className="text-xl font-semibold text-text-primary mb-2">
              {t('error_boundary.title')}
            </h1>
            <p className="text-text-secondary mb-6">
              {t('error_boundary.body')}
            </p>
            {import.meta.env.DEV && this.state.error && (
              <details className="text-left mb-4 p-3 bg-status-error/10 rounded-lg text-sm">
                <summary className="cursor-pointer text-status-error font-medium">
                  {t('error_boundary.details')}
                </summary>
                <pre className="mt-2 text-status-error/90 overflow-auto text-xs">
                  {this.state.error.message}
                  {'\n'}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-lg bg-accent-gold text-background-darkest font-medium hover:bg-accent-gold-bright transition-colors"
              >
                {t('error_boundary.try_again')}
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-background-elevated text-text-body border border-ui-border hover:bg-background-tertiary transition-colors"
              >
                {t('error_boundary.refresh')}
              </button>
            </div>
            {/* The bulletproof escape hatch: clears stale SW + caches + storage. */}
            <div className="mt-6 pt-4 border-t border-ui-border">
              <p className="text-text-muted text-xs mb-2">
                {t('error_boundary.reset_hint')}
              </p>
              {/* After a rollback refusal (caught here, or the engine's last
                  boot failure), warn + confirm before dropping the floor. */}
              <RollbackResetGuard
                rollback={
                  isRollbackRefusal(this.state.error) || isRollbackRefusal(lastEngineBootFailure())
                }
                onReset={this.handleResetAppData}
                renderTrigger={(onClick) => (
                  <button
                    onClick={onClick}
                    className="px-4 py-2 rounded-lg text-status-error border border-status-error/40 hover:bg-status-error/10 transition-colors text-sm"
                  >
                    {t('error_boundary.reset_app_data')}
                  </button>
                )}
              />
              {this.state.resetIncomplete !== undefined && (
                <ResetIncompleteNotice databases={this.state.resetIncomplete} />
              )}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const ErrorBoundary = withTranslation()(ErrorBoundaryBase);

export { ErrorBoundary };
export default ErrorBoundary;
