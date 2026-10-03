/**
 * MeshConstellation — the mesh rendered as a quiet star-map.
 *
 * The anchor ("you") sits at the centre; members hang on a slow dotted orbit,
 * tethered by hairline gold threads. Geometry comes from the pure
 * `radialNodeLayout` (one percent-coordinate space shared by the SVG threads
 * and the HTML node overlays), so the drawing is plain SVG + absolutely
 * positioned links — no graph library.
 *
 * Each node carries the person's name, relationship and (when a chart exists)
 * the engine-emitted rising sign with its glyph. A member without a generated
 * chart renders muted with a "generate chart" affordance — the caller routes
 * it through the established switch-profile → onboarding flow.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SIGNS } from '@almamesh/constants';
import type { Profile } from '@almamesh/store';

import { radialNodeLayout } from '../../../lib/mesh';
import { signName } from '../../../lib/predictiveEventCopy';

/** One person as the constellation sees them (chart facts pre-resolved). */
export interface MeshNodeVM {
  readonly profile: Profile;
  readonly hasChart: boolean;
  /** Engine-emitted rising sign (lowercase token), when a chart exists. */
  readonly lagnaSign?: string;
}

export interface MeshConstellationProps {
  readonly anchor: MeshNodeVM;
  readonly members: readonly MeshNodeVM[];
  /** A member without a chart asked to generate one (switch → onboarding). */
  readonly onGenerateChart: (profileId: string) => void;
  /** The ghost "+" star was clicked — the page opens the add-person dialog. */
  readonly onAddPerson: () => void;
}

/**
 * The zodiac glyph for a lowercase sign token (constants are display-only).
 * U+FE0E forces TEXT presentation — without it Chromium/macOS renders the
 * zodiac codepoints as color emoji, which clashes with the observatory ink.
 */
function glyphOf(sign?: string): string | undefined {
  if (!sign) {
    return undefined;
  }
  const symbol = (SIGNS as Record<string, { symbol?: string }>)[sign]?.symbol;
  return symbol ? `${symbol}\u{FE0E}` : undefined;
}

/** Initials fallback for a chartless node (no rising mark to show yet). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** The tinted star disc: rising glyph when charted, initials otherwise. */
function NodeDisc({ node, dim }: { node: MeshNodeVM; dim: string }): ReactElement {
  const glyph = node.hasChart ? glyphOf(node.lagnaSign) : undefined;
  return (
    <span
      aria-hidden="true"
      className={`flex ${dim} items-center justify-center rounded-full border-2 bg-background-secondary ${
        node.hasChart ? 'text-accent-gold' : 'border-dashed text-text-tertiary'
      }`}
      style={{ borderColor: node.profile.avatarTint }}
    >
      <span className={glyph ? 'text-xl leading-none' : 'text-xs font-medium'}>
        {glyph ?? initialsOf(node.profile.name)}
      </span>
    </span>
  );
}

/** Name + relationship + rising line under a node disc. */
function NodeCaption({
  node,
  relationshipLabel,
}: {
  node: MeshNodeVM;
  relationshipLabel: string;
}): ReactElement {
  const { t } = useTranslation(['mesh', 'predictive']);
  return (
    <span className="mt-1.5 flex max-w-[5.5rem] sm:max-w-[7.5rem] flex-col items-center text-center">
      <span className="truncate text-sm font-medium text-text-primary">{node.profile.name}</span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
        {relationshipLabel}
      </span>
      {node.hasChart && node.lagnaSign ? (
        <span className="mt-0.5 text-xs text-text-secondary">
          {t('mesh:graph.rising', { sign: signName(t, node.lagnaSign) })}
        </span>
      ) : (
        <span className="mt-0.5 text-xs text-text-tertiary">{t('mesh:graph.no_chart')}</span>
      )}
    </span>
  );
}

interface MemberNodeProps {
  readonly node: MeshNodeVM;
  readonly xPct: number;
  readonly yPct: number;
  readonly hovered: boolean;
  readonly onHover: (id: string | null) => void;
  readonly onGenerateChart: (profileId: string) => void;
}

/** A member star: link to its edge when charted, generate affordance when not. */
function MemberNode({
  node,
  xPct,
  yPct,
  hovered,
  onHover,
  onGenerateChart,
}: MemberNodeProps): ReactElement {
  const { t } = useTranslation(['mesh', 'settings']);
  const relationshipLabel =
    node.profile.relationship && node.profile.relationship !== 'self'
      ? t(`settings:people.relationships.${node.profile.relationship}`)
      : '';
  const position = { left: `${xPct}%`, top: `${yPct}%` };
  const base =
    'absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-lg p-2 ' +
    'transition-opacity focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-gold/60';

  if (!node.hasChart) {
    return (
      <button
        type="button"
        style={position}
        className={`${base} opacity-75 hover:opacity-100`}
        onClick={() => onGenerateChart(node.profile.id)}
        onMouseEnter={() => onHover(node.profile.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(node.profile.id)}
        onBlur={() => onHover(null)}
        aria-label={t('mesh:graph.generate_for', { name: node.profile.name })}
        data-testid={`mesh-node-generate-${node.profile.id}`}
      >
        <NodeDisc node={node} dim="h-12 w-12" />
        <NodeCaption node={node} relationshipLabel={relationshipLabel} />
        <span className="mt-1 rounded-full border border-accent-gold/40 px-2 py-0.5 text-[11px] text-accent-gold">
          {t('mesh:graph.generate')}
        </span>
      </button>
    );
  }

  return (
    <Link
      to={`/mesh/${node.profile.id}`}
      style={position}
      className={`${base} ${hovered ? 'opacity-100' : ''}`}
      onMouseEnter={() => onHover(node.profile.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.profile.id)}
      onBlur={() => onHover(null)}
      aria-label={t('mesh:graph.open_edge', { name: node.profile.name })}
      data-testid={`mesh-node-${node.profile.id}`}
    >
      <NodeDisc node={node} dim="h-12 w-12" />
      <NodeCaption node={node} relationshipLabel={relationshipLabel} />
    </Link>
  );
}

/**
 * The ghost "+" star: one waiting slot on the orbit that adds a person in
 * place. Dashed like every not-yet-charted node — a star you haven't lit yet.
 */
function AddPersonNode({
  xPct,
  yPct,
  onAddPerson,
}: {
  xPct: number;
  yPct: number;
  onAddPerson: () => void;
}): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <button
      type="button"
      style={{ left: `${xPct}%`, top: `${yPct}%` }}
      className={
        'group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-lg p-2 ' +
        'opacity-75 transition-opacity hover:opacity-100 focus-visible:outline-hidden ' +
        'focus-visible:ring-2 focus-visible:ring-accent-gold/60'
      }
      onClick={onAddPerson}
      aria-label={t('graph.add_aria')}
      data-testid="mesh-node-add"
    >
      <span
        aria-hidden="true"
        className={
          'flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed ' +
          'border-accent-gold/50 bg-background-secondary text-accent-gold ' +
          'transition-transform duration-200 group-hover:scale-105 group-hover:border-accent-gold ' +
          'group-focus-visible:border-accent-gold motion-reduce:transition-none'
        }
      >
        <span className="text-xl leading-none">+</span>
      </span>
      <span className="mt-1.5 max-w-[5.5rem] truncate text-sm font-medium text-text-secondary sm:max-w-[7.5rem]">
        {t('graph.add')}
      </span>
    </button>
  );
}

/** The hairline threads + slow orbit ring behind the nodes (decorative). */
function ThreadCanvas({
  members,
  positions,
  hoveredId,
}: {
  members: readonly MeshNodeVM[];
  positions: readonly { xPct: number; yPct: number }[];
  hoveredId: string | null;
}): ReactElement {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <circle
        cx="50"
        cy="50"
        r="38"
        fill="none"
        stroke="currentColor"
        strokeDasharray="0.4 2.2"
        vectorEffect="non-scaling-stroke"
        className="animate-[spin_240s_linear_infinite] text-accent-gold/20 motion-reduce:animate-none"
        style={{ transformOrigin: '50% 50%' }}
      />
      {members.map((node, index) => {
        const position = positions[index];
        if (!position) {
          return null;
        }
        const hovered = hoveredId === node.profile.id;
        return (
          <line
            key={node.profile.id}
            x1="50"
            y1="50"
            x2={position.xPct}
            y2={position.yPct}
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            className={`transition-colors ${
              hovered ? 'text-accent-gold/70' : node.hasChart ? 'text-accent-gold/25' : 'text-ui-border'
            }`}
            data-testid={`mesh-thread-${node.profile.id}`}
          />
        );
      })}
    </svg>
  );
}

/** The radial constellation: SVG threads below, accessible nodes above. */
export function MeshConstellation({
  anchor,
  members,
  onGenerateChart,
  onAddPerson,
}: MeshConstellationProps): ReactElement {
  const { t } = useTranslation('mesh');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // One extra orbit slot: the last position belongs to the ghost "+" star.
  const positions = radialNodeLayout(members.length + 1);
  const addPosition = positions[members.length];

  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-2xl overflow-hidden"
      data-testid="mesh-constellation"
    >
      <ThreadCanvas members={members} positions={positions} hoveredId={hoveredId} />

      {/* The anchor — you, at the centre of your own sky. */}
      <div
        className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center p-2"
        data-testid="mesh-anchor-node"
      >
        {anchor.hasChart ? (
          <>
            <NodeDisc node={anchor} dim="h-16 w-16" />
            <NodeCaption node={anchor} relationshipLabel={t('graph.you')} />
          </>
        ) : (
          <button
            type="button"
            className="flex flex-col items-center rounded-lg opacity-75 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-gold/60"
            onClick={() => onGenerateChart(anchor.profile.id)}
            aria-label={t('graph.generate_for', { name: anchor.profile.name })}
            data-testid={`mesh-node-generate-${anchor.profile.id}`}
          >
            <NodeDisc node={anchor} dim="h-16 w-16" />
            <NodeCaption node={anchor} relationshipLabel={t('graph.you')} />
            <span className="mt-1 rounded-full border border-accent-gold/40 px-2 py-0.5 text-[11px] text-accent-gold">
              {t('graph.generate')}
            </span>
          </button>
        )}
      </div>

      {members.map((node, index) => {
        const position = positions[index];
        if (!position) {
          return null;
        }
        return (
          <MemberNode
            key={node.profile.id}
            node={node}
            xPct={position.xPct}
            yPct={position.yPct}
            hovered={hoveredId === node.profile.id}
            onHover={setHoveredId}
            onGenerateChart={onGenerateChart}
          />
        );
      })}

      {addPosition && (
        <AddPersonNode xPct={addPosition.xPct} yPct={addPosition.yPct} onAddPerson={onAddPerson} />
      )}
    </div>
  );
}
