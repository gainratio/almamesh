/**
 * Generative Mesh relationship synastry card for `read_mesh_member`.
 *
 * Uses role-anonymized labels only (`spouse`, `partner`, `friend #1`, etc.).
 */
import { useTranslation } from 'react-i18next';
import { Link, useInRouterContext } from 'react-router-dom';

interface SynchronySegmentLike {
  readonly start_month?: string;
  readonly end_month?: string;
  readonly note?: string;
  readonly shared_lords?: readonly string[];
}

interface EdgeBodyLike {
  readonly relationship?: string;
  readonly ashtakoota?: { readonly total_points?: number; readonly max_points?: number; readonly band?: string } | null;
  readonly synchrony?: { readonly segments?: readonly SynchronySegmentLike[] } | null;
}

interface MeshCardPayload extends EdgeBodyLike {
  readonly status: string;
  readonly role_label?: string;
  readonly member_role?: string;
  readonly edge?: EdgeBodyLike;
}

function isMeshPayload(value: unknown): value is MeshCardPayload {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string, unknown>).status === 'string';
}

export function MeshSynastryCard({ result }: { readonly result: unknown }) {
  const { t } = useTranslation('chat');
  const inRouter = useInRouterContext();
  if (!isMeshPayload(result)) return null;

  const role = result.role_label ?? result.member_role;
  const body: EdgeBodyLike | undefined = result.edge ?? (result.ashtakoota || result.synchrony ? result : undefined);

  const meshLink = inRouter ? (
    <Link to="/mesh" data-testid="mesh-card-link" className="font-medium text-accent-gold underline hover:no-underline">
      {t('cards.mesh.open_mesh')}
    </Link>
  ) : (
    <a href="/mesh" data-testid="mesh-card-link" className="font-medium text-accent-gold underline hover:no-underline">
      {t('cards.mesh.open_mesh')}
    </a>
  );

  if (result.status !== 'ready' || !body) {
    return (
      <section
        aria-label={t('cards.mesh.title')}
        data-testid="tool-card-mesh-synastry"
        data-mesh-status={result.status}
        className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-background-secondary p-3 text-xs text-text-secondary"
      >
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-accent-gold">⚭</span>
          <span>
            {result.status === 'empty_mesh' || result.status === 'no_members'
              ? t('cards.mesh.no_members')
              : t('cards.mesh.setup_needed', { role: role ?? 'member' })}
          </span>
        </div>
        {meshLink}
      </section>
    );
  }

  const koota = body.ashtakoota;
  const segments = body.synchrony?.segments ?? [];

  return (
    <section
      aria-label={t('cards.mesh.title')}
      data-testid="tool-card-mesh-synastry"
      data-mesh-status="ready"
      className="mb-2 rounded-xl border border-ui-border bg-background-secondary p-3 text-xs"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-text-primary">
          <span aria-hidden="true" className="text-accent-gold">⚭</span>
          <span>{t('cards.mesh.title')}</span>
          {role && <span className="text-text-muted">· {role}</span>}
        </div>
        <div className="flex items-center gap-2">
          {koota && typeof koota.total_points === 'number' && (
            <span
              data-testid="mesh-card-ashtakoota"
              className="rounded-full border border-accent-gold/40 bg-accent-gold/10 px-2 py-0.5 text-[11px] font-medium text-accent-gold"
            >
              {koota.total_points}/{koota.max_points ?? 36}{koota.band ? ` · ${koota.band}` : ''}
            </span>
          )}
          {meshLink}
        </div>
      </div>

      {segments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {segments.slice(0, 3).map((seg, idx) => {
            const label = seg.note ?? (seg.shared_lords?.length ? seg.shared_lords.join(', ') : undefined);
            return (
              <span
                key={`${seg.start_month ?? idx}`}
                className="rounded-lg border border-ui-border/80 bg-background-primary px-2 py-1 text-[11px] text-text-secondary"
              >
                {seg.start_month}{seg.end_month ? ` – ${seg.end_month}` : ''}
                {label ? ` · ${label}` : ''}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
