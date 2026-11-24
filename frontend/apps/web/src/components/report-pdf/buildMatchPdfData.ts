/**
 * buildMatchPdfData — pure presentation reshaper for the locally-generated
 * Kundli Matching / Relationship PDF report (`MatchReportDocument`).
 *
 * Computes ZERO astrology: every score, band, dosha, cancellation, overlay
 * contact, synchrony window, and chart placement arrives verbatim from the
 * Python engine's `MeshEdgeCtx` and stored `SiderealChart`s.
 */

import type { SiderealChart } from '@almamesh/browser/types';
import type { MemberRelationship, MeshEdgeCtx } from '@almamesh/shared-types';
import { buildChartGeometry, type ChartGeometry } from '@almamesh/store';
import type { ReportPdfTable } from './types';
import { containsDevanagari, glyphSafe } from './glyphSafe';

export interface MatchPdfLabels {
  readonly kicker: string;
  readonly subtitle: string;
  readonly footerNote: string;
  readonly chartsEyebrow: string;
  readonly chartsTitle: string;
  readonly compatEyebrow: string;
  readonly compatTitle: string;
  readonly maitriTitle: string;
  readonly doshasTitle: string;
  readonly mangalTitle: string;
  readonly mangalMutual: string;
  readonly overlayEyebrow: string;
  readonly overlayTitle: string;
  readonly synchronyEyebrow: string;
  readonly synchronyTitle: string;
  readonly integrityLabel: string;
  readonly colKoota: string;
  readonly colScore: string;
  readonly colBasis: string;
  readonly colPerson: string;
  readonly colReference: string;
  readonly colStatus: string;
  readonly colContact: string;
  readonly colKind: string;
  readonly colOrb: string;
  readonly colWindow: string;
  readonly colAnchorDasha: string;
  readonly colMemberDasha: string;
  readonly colShared: string;
  readonly kootaLabel: (koota: string) => string;
  readonly bandLabel: (band: string) => string;
  readonly doshaStatus: (present: boolean, cancelled: boolean) => string;
  readonly mangalRefLabel: (ref: string) => string;
  readonly mangalStatus: (inHouse: boolean, netDosha: boolean) => string;
}

export interface BuildMatchPdfInput {
  readonly anchorName: string;
  readonly memberName: string;
  readonly relationship: MemberRelationship;
  readonly relationshipLabel: string;
  readonly ayanamsaLabel: string;
  readonly generatedAt: string;
  readonly edge: MeshEdgeCtx;
  readonly anchorChart?: SiderealChart | null;
  readonly memberChart?: SiderealChart | null;
  readonly locale?: string;
  readonly labels: MatchPdfLabels;
}

export interface MatchPdfData {
  readonly devanagari: boolean;
  readonly title: string;
  readonly kicker: string;
  readonly subtitle: string;
  readonly generatedOn: string;
  readonly creationDate: Date;
  readonly ayanamsaLabel: string;
  readonly anchorName: string;
  readonly memberName: string;
  readonly anchorGeometry: ChartGeometry | null;
  readonly memberGeometry: ChartGeometry | null;
  readonly isMarriage: boolean;
  readonly totalScoreLine: string | null;
  readonly moonPairLine: string | null;
  readonly kootaTable: ReportPdfTable | null;
  readonly doshaLines: readonly string[];
  readonly mangalTable: ReportPdfTable | null;
  readonly mangalMutualNote: string | null;
  readonly grahaMaitriLine: string | null;
  readonly overlayTable: ReportPdfTable | null;
  readonly synchronyTable: ReportPdfTable | null;
  readonly integrityNote: string;
  readonly labels: MatchPdfLabels;
}

function safeGeometry(chart: SiderealChart | null | undefined): ChartGeometry | null {
  if (!chart) return null;
  try {
    return buildChartGeometry(chart);
  } catch {
    return null;
  }
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function buildMatchPdfData(input: BuildMatchPdfInput): MatchPdfData {
  const { anchorName, memberName, edge, labels } = input;
  const isMarriage = input.relationship === 'spouse' || input.relationship === 'partner';
  const creationDate = new Date(input.generatedAt);
  const validCreationDate = Number.isNaN(creationDate.valueOf()) ? new Date(0) : creationDate;

  const ak = edge.ashtakoota;
  const kootaTable: ReportPdfTable | null =
    isMarriage && ak
      ? {
          headers: [labels.colKoota, labels.colScore, labels.colBasis],
          widths: [1.4, 0.9, 3.2],
          rows: [
            ...ak.kootas.map((k) => ({
              cells: [
                glyphSafe(labels.kootaLabel(k.koota)),
                `${k.earned} / ${k.maximum}`,
                glyphSafe(k.basis),
              ],
            })),
            {
              emphasis: true,
              cells: [
                glyphSafe(labels.bandLabel(ak.band)),
                `${ak.total} / ${ak.maximum}`,
                glyphSafe(ak.band_basis),
              ],
            },
          ],
        }
      : null;

  const doshaLines: string[] = [];
  if (isMarriage && ak) {
    for (const flag of [ak.bhakoot_dosha, ak.nadi_dosha]) {
      const status = labels.doshaStatus(flag.present, flag.cancelled);
      doshaLines.push(glyphSafe(`${flag.name.replace('_', ' ')}: ${status} — ${flag.basis}`));
    }
  }

  const mangal = edge.mangal_match;
  const mangalTable: ReportPdfTable | null =
    isMarriage && mangal
      ? {
          headers: [labels.colPerson, labels.colReference, labels.colStatus],
          widths: [1.4, 1.8, 2.2],
          rows: [
            ...mangal.a.references.map((r) => ({
              cells: [
                glyphSafe(anchorName),
                glyphSafe(labels.mangalRefLabel(r.reference)),
                glyphSafe(
                  `Mars ${r.mars_sign} H${r.mars_house} · ${labels.mangalStatus(r.in_dosha_house, r.net_dosha)}`,
                ),
              ],
            })),
            ...mangal.b.references.map((r) => ({
              cells: [
                glyphSafe(memberName),
                glyphSafe(labels.mangalRefLabel(r.reference)),
                glyphSafe(
                  `Mars ${r.mars_sign} H${r.mars_house} · ${labels.mangalStatus(r.in_dosha_house, r.net_dosha)}`,
                ),
              ],
            })),
          ],
        }
      : null;

  const grahaMaitriKoota = ak?.kootas.find((k) => k.koota === 'graha_maitri');
  const grahaMaitriLine =
    !isMarriage && grahaMaitriKoota
      ? glyphSafe(
          `${grahaMaitriKoota.earned} / ${grahaMaitriKoota.maximum} — ${grahaMaitriKoota.basis}`,
        )
      : null;

  const overlayContacts = [
    ...edge.overlay.b_in_a.contacts.slice(0, 6).map((c) => ({
      who: `${memberName} ${c.planet} -> ${anchorName} ${c.target}`,
      kind: c.kind.replace(/_/g, ' '),
      orb: c.orb_degrees !== null ? `${c.orb_degrees.toFixed(1)}°` : '—',
    })),
    ...edge.overlay.a_in_b.contacts.slice(0, 6).map((c) => ({
      who: `${anchorName} ${c.planet} -> ${memberName} ${c.target}`,
      kind: c.kind.replace(/_/g, ' '),
      orb: c.orb_degrees !== null ? `${c.orb_degrees.toFixed(1)}°` : '—',
    })),
  ];

  const overlayTable: ReportPdfTable | null =
    overlayContacts.length > 0
      ? {
          headers: [labels.colContact, labels.colKind, labels.colOrb],
          widths: [2.8, 1.5, 0.8],
          rows: overlayContacts.map((row) => ({
            cells: [glyphSafe(row.who), glyphSafe(row.kind), glyphSafe(row.orb)],
          })),
        }
      : null;

  const synchronyTable: ReportPdfTable | null =
    edge.synchrony.segments.length > 0
      ? {
          headers: [
            labels.colWindow,
            labels.colAnchorDasha,
            labels.colMemberDasha,
            labels.colShared,
          ],
          widths: [1.6, 1.4, 1.4, 1.1],
          rows: edge.synchrony.segments.slice(0, 14).map((seg) => ({
            cells: [
              `${shortDate(seg.start)} -> ${shortDate(seg.end)}`,
              glyphSafe(`${seg.a_maha} / ${seg.a_antar ?? '—'}`),
              glyphSafe(`${seg.b_maha} / ${seg.b_antar ?? '—'}`),
              glyphSafe(seg.shared_lords.length > 0 ? seg.shared_lords.join(', ') : '—'),
            ],
            emphasis: seg.shared_lords.length > 0,
          })),
        }
      : null;

  const anchorMoon = ak ? (edge.role_a === 'bride' ? ak.bride_moon : ak.groom_moon) : null;
  const memberMoon = ak ? (edge.role_a === 'bride' ? ak.groom_moon : ak.bride_moon) : null;

  const baseData: Omit<MatchPdfData, 'devanagari'> = {
    title: glyphSafe(`${anchorName} & ${memberName}`),
    kicker: glyphSafe(`${labels.kicker} · ${input.relationshipLabel}`),
    subtitle: glyphSafe(labels.subtitle),
    generatedOn: shortDate(input.generatedAt),
    creationDate: validCreationDate,
    ayanamsaLabel: glyphSafe(input.ayanamsaLabel),
    anchorName: glyphSafe(anchorName),
    memberName: glyphSafe(memberName),
    anchorGeometry: safeGeometry(input.anchorChart),
    memberGeometry: safeGeometry(input.memberChart),
    isMarriage,
    totalScoreLine:
      isMarriage && ak
        ? glyphSafe(`${ak.total} / ${ak.maximum} · ${labels.bandLabel(ak.band)}`)
        : null,
    moonPairLine:
      anchorMoon && memberMoon
        ? glyphSafe(
            `${anchorName}: ${anchorMoon.nakshatra} (P${anchorMoon.nakshatra_pada}, ${anchorMoon.sign}) · ` +
              `${memberName}: ${memberMoon.nakshatra} (P${memberMoon.nakshatra_pada}, ${memberMoon.sign})`,
          )
        : null,
    kootaTable,
    doshaLines,
    mangalTable,
    mangalMutualNote: isMarriage && mangal?.mutually_cancelled ? glyphSafe(labels.mangalMutual) : null,
    grahaMaitriLine,
    overlayTable,
    synchronyTable,
    integrityNote: glyphSafe(edge.integrity_note),
    labels,
  };

  const devanagari =
    Boolean(input.locale?.toLowerCase().startsWith('hi')) ||
    containsDevanagari(
      JSON.stringify({
        title: baseData.title,
        kicker: baseData.kicker,
        subtitle: baseData.subtitle,
        ayanamsaLabel: baseData.ayanamsaLabel,
        totalScoreLine: baseData.totalScoreLine,
        moonPairLine: baseData.moonPairLine,
        kootaTable: baseData.kootaTable,
        doshaLines: baseData.doshaLines,
        mangalTable: baseData.mangalTable,
        mangalMutualNote: baseData.mangalMutualNote,
        grahaMaitriLine: baseData.grahaMaitriLine,
        overlayTable: baseData.overlayTable,
        synchronyTable: baseData.synchronyTable,
        integrityNote: baseData.integrityNote,
        footerNote: labels.footerNote,
      }),
    );

  return { devanagari, ...baseData };
}
