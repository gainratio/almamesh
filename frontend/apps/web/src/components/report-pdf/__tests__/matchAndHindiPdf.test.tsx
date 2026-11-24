// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToBuffer } from '@react-pdf/renderer';
import { MatchReportDocument } from '../MatchReportDocument';
import { buildMatchPdfData, type MatchPdfLabels } from '../buildMatchPdfData';
import { containsDevanagari, glyphSafe } from '../glyphSafe';
import { registerReportFonts } from '../theme';
import { canonicalizeFontSubsetTags } from '../../../lib/reportPdfDeterminism';
import { MESH_EDGE_SPOUSE } from '../../../test/meshFixtures';

const FONT_DIR = path.resolve('public/fonts');

const LABELS_EN: MatchPdfLabels = {
  kicker: 'The mesh',
  subtitle: 'Two finished charts, read side by side. Neither changes the other.',
  footerNote: 'AlmaMesh · Local-only',
  chartsEyebrow: 'D1 · Rasi',
  chartsTitle: 'Asha Rao & Dev Rao',
  compatEyebrow: 'Guna Milan · marriage tables',
  compatTitle: 'Compatibility',
  maitriTitle: 'Graha Maitri',
  doshasTitle: 'Dosha flags',
  mangalTitle: 'Mangal (Kuja) dosha',
  mangalMutual: 'Mutually cancelled — both charts carry it.',
  overlayEyebrow: 'two-way overlay',
  overlayTitle: 'Connection',
  synchronyEyebrow: 'dasa synchrony',
  synchronyTitle: 'Together in time',
  integrityLabel: 'Read-only promise',
  colKoota: 'Koota',
  colScore: 'Score',
  colBasis: 'Basis',
  colPerson: 'Chart',
  colReference: 'Reference',
  colStatus: 'Status',
  colContact: 'Contact',
  colKind: 'Aspect',
  colOrb: 'Orb',
  colWindow: 'Window',
  colAnchorDasha: 'Asha',
  colMemberDasha: 'Dev',
  colShared: 'Shared',
  kootaLabel: (k) => k,
  bandLabel: (b) => b,
  doshaStatus: (p, c) => (!p ? 'clear' : c ? 'cancelled' : 'present'),
  mangalRefLabel: (r) => r,
  mangalStatus: (i, n) => (!i ? 'clear' : n ? 'dosha house' : 'cancelled'),
};

describe('MatchReportDocument and Hindi Devanagari PDF support', () => {
  it('preserves Devanagari Unicode losslessly through glyphSafe', () => {
    const hindi = 'कुंडली मिलान — अष्टकूट गुण मिलान · वर्षफल';
    expect(containsDevanagari(hindi)).toBe(true);
    expect(containsDevanagari('AlmaMesh Kundli')).toBe(false);
    expect(glyphSafe(hindi)).toBe(hindi);
  });

  it('renders a deterministic English Match PDF to valid PDF bytes', async () => {
    registerReportFonts(FONT_DIR, { devanagari: false });
    const data = buildMatchPdfData({
      anchorName: 'Asha Rao',
      memberName: 'Dev Rao',
      relationship: 'spouse',
      relationshipLabel: 'Spouse',
      ayanamsaLabel: 'Lahiri',
      generatedAt: '2026-06-01T00:00:00Z',
      edge: MESH_EDGE_SPOUSE,
      labels: LABELS_EN,
    });

    const first = canonicalizeFontSubsetTags(
      new Uint8Array(await renderToBuffer(<MatchReportDocument data={data} />)),
    );
    const second = canonicalizeFontSubsetTags(
      new Uint8Array(await renderToBuffer(<MatchReportDocument data={data} />)),
    );

    expect(new TextDecoder('ascii').decode(first.slice(0, 5))).toBe('%PDF-');
    expect(first.byteLength).toBeGreaterThan(5_000);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('renders a Hindi Devanagari Match PDF using self-hosted Noto Sans Devanagari TTFs', async () => {
    registerReportFonts(FONT_DIR, { devanagari: true });
    const data = buildMatchPdfData({
      anchorName: 'आशा राव',
      memberName: 'देव राव',
      relationship: 'spouse',
      relationshipLabel: 'जीवनसाथी',
      ayanamsaLabel: 'लाहिड़ी',
      generatedAt: '2026-06-01T00:00:00Z',
      edge: MESH_EDGE_SPOUSE,
      labels: {
        ...LABELS_EN,
        kicker: 'कुंडली मिलान',
        subtitle: 'दो पूर्ण जन्म कुंडलियाँ, साथ-साथ पढ़ी गईं।',
        compatTitle: 'अष्टकूट गुण मिलान',
        footerNote: 'AlmaMesh · स्थानीय गणना',
      },
    });

    const buf = new Uint8Array(await renderToBuffer(<MatchReportDocument data={data} />));
    expect(new TextDecoder('ascii').decode(buf.slice(0, 5))).toBe('%PDF-');
    expect(buf.byteLength).toBeGreaterThan(5_000);
  });
});
