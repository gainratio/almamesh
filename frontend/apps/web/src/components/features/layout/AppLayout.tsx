import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Footer } from '../../Footer';
import { ProfileSwitcher } from '../profiles/ProfileSwitcher';
import { DataRepairNotice } from '../settings/DataRepairNotice';
import { AiStatusBadge } from './AiStatusBadge';
import { DroppedWritesNotice } from './DroppedWritesNotice';
import { MeshNavButton } from './MeshNavButton';

export interface AppLayoutProps {
  children: ReactNode;
  /**
   * Render the shared provenance/legal footer. Defaults to `false` because most
   * pages currently render their own footer inline; set `true` for pages that
   * don't. (Phase >0 will consolidate footers here.)
   */
  showFooter?: boolean;
}

/**
 * AppLayout — the observatory app shell.
 *
 * Header (wordmark + named-profile switcher + live AI-status badge linking to
 * AI Model settings),
 * an atmospheric obsidian main region (starfield + faint astrolabe rings), and
 * an optional shared footer. Page bodies render unchanged inside `main`.
 */
export function AppLayout({ children, showFooter = false }: AppLayoutProps) {
  const { t } = useTranslation('common');
  return (
    // `min-h-dvh` tracks the visible viewport so the shell is not left sitting
    // behind mobile Safari's collapsing URL bar.
    <div className="flex min-h-dvh flex-col bg-observatory">
      <header className="sticky top-0 z-40 border-b border-ui-border bg-background-primary/80 backdrop-blur-sm">
        <div className="app-gutter mx-auto flex h-14 w-full max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-5">
            {/* Wordmark — manuscript display face. Links to the shareable
                `/welcome` splash so a returning visitor can always revisit the
                landing (the bare `/` would just bounce them to /dashboard). */}
            <Link
              to="/welcome"
              className="font-display text-xl tracking-tight text-text-primary transition-colors hover:text-accent-gold-bright"
              aria-label={t('nav.home')}
            >
              Alma<span className="text-accent-gold">Mesh</span>
            </Link>

            {/* The namesake surface — always reachable; /mesh itself renders
                the invitation state until an anchor + members exist. Drawn as a mesh
                glyph, not the word, so it reads as something to press. */}
            <MeshNavButton />
          </div>

          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {/* Named-profile switcher — multi-user on a shared device, no login. */}
            <ProfileSwitcher />

            {/* Live AI-provider status + one-click entry to AI Model settings. */}
            <AiStatusBadge />
          </div>
        </div>
      </header>

      <main className="bg-astrolabe-rings flex-1">
        <div className="app-gutter mx-auto w-full max-w-7xl py-6 md:py-8">
          <DataRepairNotice />
          <DroppedWritesNotice />
          {children}
        </div>
      </main>

      {showFooter && <Footer />}
    </div>
  );
}
