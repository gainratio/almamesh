/**
 * CompatibilitySection — Ashtakoota Guna Milan + Mangal dosha, rendered ONLY
 * for spouse/partner edges (the classical tables are marriage tables; the
 * page curates by relationship).
 *
 * Calm typography, zero fear styling: every score, band, dosha and
 * cancellation is the engine's verbatim output; the /36 band is labeled a
 * classical convention — a label, not a verdict. The role-seat control states
 * plainly that the tables are role-asymmetric and lets the reader choose whose
 * chart the bride-table rules read for (no gender is ever assumed).
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DoshaFlagData,
  KootaResultData,
  MangalDoshaData,
  MangalReferenceData,
  MeshEdgeCtx,
} from '@almamesh/shared-types';

import { Badge, Card } from '../../ui';
import type { BrideTableSide } from '../../../lib/mesh';
import { signName } from '../../../lib/predictiveEventCopy';
import { MoonPair } from './MoonPair';

export interface CompatibilitySectionProps {
  readonly edge: MeshEdgeCtx;
  readonly memberName: string;
  readonly brideSide: BrideTableSide;
  readonly onBrideSideChange: (side: BrideTableSide) => void;
}

/** Plain-language role seat: whose chart the bride-table rules read for. */
function RoleSeatControl({
  memberName,
  brideSide,
  onBrideSideChange,
}: Pick<CompatibilitySectionProps, 'memberName' | 'brideSide' | 'onBrideSideChange'>): ReactElement {
  const { t } = useTranslation('mesh');
  const seatClass = (active: boolean): string =>
    `px-3 py-1 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-gold/60 ${
      active ? 'bg-accent-gold/10 font-medium text-accent-gold' : 'text-text-secondary hover:text-text-primary'
    }`;
  return (
    <div className="space-y-2" data-testid="mesh-role-seat">
      <p className="max-w-prose text-xs leading-relaxed text-text-secondary">
        {t('compat.roles_label')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
          {t('compat.roles_read_for')}
        </span>
        <div
          role="group"
          aria-label={t('compat.roles_read_for')}
          className="inline-flex divide-x divide-ui-border overflow-hidden rounded-lg border border-ui-border"
        >
          <button
            type="button"
            aria-pressed={brideSide === 'anchor'}
            className={seatClass(brideSide === 'anchor')}
            onClick={() => onBrideSideChange('anchor')}
            data-testid="mesh-role-anchor"
          >
            {t('compat.role_you')}
          </button>
          <button
            type="button"
            aria-pressed={brideSide === 'member'}
            className={seatClass(brideSide === 'member')}
            onClick={() => onBrideSideChange('member')}
            data-testid="mesh-role-member"
          >
            {memberName}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One koota row: name, basis, earned/max numerals and a hairline bar. */
function KootaRow({ koota }: { koota: KootaResultData }): ReactElement {
  const { t } = useTranslation('mesh');
  const widthPct = koota.maximum > 0 ? (koota.earned / koota.maximum) * 100 : 0;
  return (
    <li className="py-2.5" data-testid={`mesh-koota-${koota.koota}`}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium text-text-primary">
          {t(`compat.koota.${koota.koota}`, { defaultValue: koota.koota })}
        </span>
        <span className="font-mono text-xs text-text-secondary">
          {koota.earned}
          <span className="text-text-tertiary"> / {koota.maximum}</span>
        </span>
      </div>
      <div className="mt-1.5 h-px w-full bg-ui-border" aria-hidden="true">
        <div className="h-px bg-accent-gold" style={{ width: `${widthPct}%` }} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-tertiary">{koota.basis}</p>
    </li>
  );
}

/** A dosha verdict in calm words: not present / present—cancelled / present. */
function DoshaLine({ dosha }: { dosha: DoshaFlagData }): ReactElement {
  const { t } = useTranslation('mesh');
  const statusKey = !dosha.present
    ? 'compat.dosha_clear'
    : dosha.cancelled
      ? 'compat.dosha_cancelled'
      : 'compat.dosha_present';
  return (
    <div data-testid={`mesh-dosha-${dosha.name}`}>
      <p className="text-sm text-text-primary">
        <span className="font-medium">{t(`compat.dosha.${dosha.name}`)}</span>{' '}
        <span className="text-text-secondary">— {t(statusKey)}</span>
      </p>
      <p className="text-xs leading-relaxed text-text-tertiary">{dosha.basis}</p>
      {dosha.cancellations.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {dosha.cancellations.map((cancellation) => (
            <li key={cancellation.rule} className="text-xs text-text-secondary">
              {t('compat.cancelled_by')} {cancellation.description}
              <span className="text-text-tertiary"> · {cancellation.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One Mars reference row (per classical school), verbatim. */
function MangalReferenceRow({ reference }: { reference: MangalReferenceData }): ReactElement {
  const { t } = useTranslation(['mesh', 'predictive']);
  const stateKey = !reference.in_dosha_house
    ? 'mesh:compat.mangal_clear'
    : reference.net_dosha
      ? 'mesh:compat.mangal_net'
      : 'mesh:compat.mangal_cancelled';
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
      <span className="text-text-secondary">{t(`mesh:compat.mangal_ref.${reference.reference}`)}</span>
      <span className="text-text-tertiary">
        {t('mesh:compat.mangal_position', {
          sign: signName(t, reference.mars_sign),
          house: reference.mars_house,
        })}
        {' · '}
        <span className={reference.net_dosha ? 'text-text-secondary' : ''}>{t(stateKey)}</span>
      </span>
    </li>
  );
}

/** One person's Mangal column: three references + the per-chart summary. */
function MangalColumn({
  label,
  mangal,
}: {
  label: string;
  mangal: MangalDoshaData;
}): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
        {label}
      </p>
      <ul className="mt-2 space-y-1.5">
        {mangal.references.map((reference) => (
          <MangalReferenceRow key={reference.reference} reference={reference} />
        ))}
      </ul>
      <p className="mt-2 text-xs text-text-secondary">
        {t(mangal.has_dosha ? 'compat.mangal_summary_has' : 'compat.mangal_summary_clear')}
      </p>
    </div>
  );
}

export function CompatibilitySection({
  edge,
  memberName,
  brideSide,
  onBrideSideChange,
}: CompatibilitySectionProps): ReactElement {
  const { t } = useTranslation('mesh');
  const { ashtakoota, mangal_match } = edge;
  return (
    <Card
      title={t('compat.heading')}
      actions={<Badge>{t('compat.badge')}</Badge>}
      data-testid="mesh-compatibility"
    >
      <div className="space-y-6">
        <RoleSeatControl
          memberName={memberName}
          brideSide={brideSide}
          onBrideSideChange={onBrideSideChange}
        />

        <MoonPair anchorRole={edge.role_a} ashtakoota={ashtakoota} memberName={memberName} />

        <ul className="divide-y divide-ui-border/60 border-y border-ui-border/60">
          {ashtakoota.kootas.map((koota) => (
            <KootaRow key={koota.koota} koota={koota} />
          ))}
        </ul>

        {/* The /36 total — a classical label, stated as such. */}
        <div data-testid="mesh-guna-total">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-display text-3xl leading-none text-text-primary">
              {ashtakoota.total}
            </span>
            <span className="text-sm text-text-secondary">
              {t('compat.of_max', { max: ashtakoota.maximum })}
            </span>
            <Badge variant="brass">{t(`compat.bands.${ashtakoota.band}`)}</Badge>
          </p>
          <p className="mt-1.5 text-xs text-text-secondary">{t('compat.total_note')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-tertiary">
            {ashtakoota.band_basis} · {ashtakoota.source}
          </p>
        </div>

        <div className="space-y-3 border-t border-ui-border/60 pt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
            {t('compat.doshas_heading')}
          </p>
          <DoshaLine dosha={ashtakoota.bhakoot_dosha} />
          <DoshaLine dosha={ashtakoota.nadi_dosha} />
        </div>

        {/* Mangal (Kuja) — both charts, three classical references each. */}
        <div className="space-y-3 border-t border-ui-border/60 pt-4" data-testid="mesh-mangal">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
            {t('compat.mangal_heading')}
          </p>
          <div className="grid grid-cols-1 gap-x-10 gap-y-4 sm:grid-cols-2">
            <MangalColumn label={t('compat.mangal_you')} mangal={mangal_match.a} />
            <MangalColumn label={memberName} mangal={mangal_match.b} />
          </div>
          {mangal_match.mutually_cancelled && (
            <p className="text-sm text-text-secondary" data-testid="mesh-mangal-mutual">
              {t('compat.mangal_mutual')}
            </p>
          )}
          <p className="text-xs leading-relaxed text-text-tertiary">
            {mangal_match.basis} · {mangal_match.source}
          </p>
        </div>
      </div>
    </Card>
  );
}
