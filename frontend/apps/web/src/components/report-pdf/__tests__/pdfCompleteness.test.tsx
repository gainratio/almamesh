/**
 * The PDF must not silently drop what the screen shows.
 *
 * Four gaps this suite pins down, all of them "the durable artifact quietly
 * says less than the app did":
 *   1. No AI reading → the Interpretation section VANISHED with no explanation.
 *      It must always appear, with an honest localized note when there is no
 *      reading yet (never a blank page, never a fabricated narrative).
 *   3. The on-screen `StabilityChip` ("birth-time sensitive") never reached the
 *      PDF — the honesty furniture was missing from the printed verdict.
 *   4. `integrated_yoga_narrative` (the LLM's woven yoga story) was dropped.
 *
 * Defect 2 (hardcoded English narrative titles) is a pure-builder concern and
 * lives in `narrativeTitles.test.ts`.
 *
 * `@react-pdf/renderer` is mocked to plain DOM primitives (the same shim
 * `rectificationWidowControl.test.tsx` uses) so the section components can be
 * asserted with testing-library instead of a full PDF render.
 */
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReportPdfData, ReportPdfDomainBlock, ReportPdfYoga } from '../types';
import { ReportPdfNarrative } from '../sections/ReportPdfNarrative';
import { ReportPdfYogas } from '../sections/ReportPdfYogas';
import { ReportPdfDomains } from '../sections/ReportPdfDomains';

vi.mock('@react-pdf/renderer', () => ({
  Font: { register: vi.fn(), registerHyphenationCallback: vi.fn() },
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  View: ({ children, wrap }: { readonly children?: ReactNode; readonly wrap?: boolean }) => (
    <div data-pdf-view="true" data-pdf-wrap={wrap === undefined ? undefined : String(wrap)}>
      {children}
    </div>
  ),
}));

const NARRATIVE_LABELS = {
  narrativeEyebrow: 'Section VII',
  narrativeTitle: 'Interpretation',
  narrativeIntro: 'A reading woven from the placements above.',
  yogasEyebrow: 'Section VI',
  yogasTitle: 'Yogas',
  yogasIntro: 'The named planetary combinations.',
};

const ABSENT_NOTE = 'ABSENT-NOTE-SENTINEL: no AI reading has been generated yet.';

function narrativeData(overrides: Record<string, unknown> = {}): ReportPdfData {
  return {
    labels: { ...NARRATIVE_LABELS, narrativeAbsentNote: ABSENT_NOTE },
    ...overrides,
  } as unknown as ReportPdfData;
}

const YOGA: ReportPdfYoga = {
  name: 'Gaja Kesari Yoga',
  classification: 'Raja · Strong',
  description: 'Jupiter in a kendra from the Moon.',
  signature: 'Jupiter · Moon',
  grade: 'strong',
  strength: '75% · Strong · structural estimate',
  strengthLedger: 'Jupiter exalted +1 · net +2 on the -3...+3 scale',
};

function yogasData(overrides: Record<string, unknown> = {}): ReportPdfData {
  return {
    labels: NARRATIVE_LABELS,
    yogas: [YOGA],
    ...overrides,
  } as unknown as ReportPdfData;
}

const DOMAIN_BLOCK: ReportPdfDomainBlock = {
  name: 'Career',
  band: '62% · Moderate',
  strengthAxes: 'Sadbala 55% · Astakavarga 70% — model estimate',
  strengthLine: 'Key graha Saturn.',
  assay: {
    heading: 'How calculated — Assay',
    method: 'Minimum of two inputs.',
    components: [],
  },
  avow: {
    heading: 'What verified — Avow',
    status: 'Unavailable',
    scope: 'Integrity only.',
  },
  emphasisLine: 'Saturn mahadasa running.',
  windowsLabel: 'Upcoming windows',
  windows: [],
  windowsEmpty: 'No windows',
};

function domainsData(block: ReportPdfDomainBlock): ReportPdfData {
  return {
    labels: NARRATIVE_LABELS,
    domains: {
      chrome: { eyebrow: 'Section XI', title: 'Life Domains', intro: 'intro' },
      blocks: [block],
    },
  } as unknown as ReportPdfData;
}

describe('Defect 1 — the Interpretation section never silently vanishes', () => {
  it('renders the heading plus the honest absent-note when there is no reading', () => {
    render(<ReportPdfNarrative data={narrativeData({ narrative: undefined })} />);
    expect(screen.getByText('Interpretation')).toBeTruthy();
    expect(screen.getByText(ABSENT_NOTE)).toBeTruthy();
  });

  it('renders the heading plus the absent-note when the narrative is an empty list', () => {
    render(<ReportPdfNarrative data={narrativeData({ narrative: [] })} />);
    expect(screen.getByText('Interpretation')).toBeTruthy();
    expect(screen.getByText(ABSENT_NOTE)).toBeTruthy();
  });

  it('falls back to a non-empty English note when the label was not injected', () => {
    const data = {
      labels: { ...NARRATIVE_LABELS, narrativeIntro: 'Woven from the placements above.' },
      narrative: undefined,
    } as unknown as ReportPdfData;
    const { container } = render(<ReportPdfNarrative data={data} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Interpretation');
    // The fallback must name WHY the section is empty — an AI reading is
    // optional and bring-your-own-key — not merely restate the section intro.
    expect(text).toContain('AI reading');
  });

  it('never shows the absent-note once a real narrative exists', () => {
    const data = narrativeData({
      narrative: [{ title: 'Strengths', paragraphs: ['You endure.'] }],
    });
    render(<ReportPdfNarrative data={data} />);
    expect(screen.getByText('You endure.')).toBeTruthy();
    expect(screen.queryByText(ABSENT_NOTE)).toBeNull();
  });
});

describe('Defect 3 — the birth-time stability marker reaches the PDF', () => {
  it('prints a yoga stability flag when one was supplied', () => {
    const data = yogasData({ yogas: [{ ...YOGA, stability: 'birth-time sensitive' }] });
    render(<ReportPdfYogas data={data} />);
    expect(screen.getByText('birth-time sensitive')).toBeTruthy();
  });

  it('renders exactly as before when no yoga stability marker exists', () => {
    render(<ReportPdfYogas data={yogasData()} />);
    expect(screen.queryByText(/birth-time/)).toBeNull();
    expect(screen.getByText('Gaja Kesari Yoga')).toBeTruthy();
  });

  it('prints plain-language yoga meaning and chart-specific basis when supplied', () => {
    const data = yogasData({
      yogas: [
        {
          ...YOGA,
          meaning: 'What it means: Jupiter placed in an angular house from the Moon.',
          basis: 'In this chart: Jupiter in the 4th from the Moon — BPHS',
        },
      ],
    });
    render(<ReportPdfYogas data={data} />);
    expect(
      screen.getByText('What it means: Jupiter placed in an angular house from the Moon.'),
    ).toBeTruthy();
    expect(screen.getByText('In this chart: Jupiter in the 4th from the Moon — BPHS')).toBeTruthy();
  });

  it('prints a life-domain stability flag when one was supplied', () => {
    render(<ReportPdfDomains data={domainsData({ ...DOMAIN_BLOCK, stability: 'birth-time stable' })} />);
    expect(screen.getByText('birth-time stable')).toBeTruthy();
  });

  it('renders exactly as before when no domain stability marker exists', () => {
    render(<ReportPdfDomains data={domainsData(DOMAIN_BLOCK)} />);
    expect(screen.queryByText(/birth-time/)).toBeNull();
    expect(screen.getByText('Career')).toBeTruthy();
  });

  it('prints the legacy strength-axes ledger alongside the new proof panels', () => {
    render(<ReportPdfDomains data={domainsData(DOMAIN_BLOCK)} />);

    expect(screen.getByText(DOMAIN_BLOCK.strengthAxes)).toBeTruthy();
    expect(screen.getByText('How calculated — Assay')).toBeTruthy();
    expect(screen.getByText('What verified — Avow')).toBeTruthy();
  });
});

describe('Defect 4 — the woven yoga narrative is printed', () => {
  it('renders every integrated-yoga-narrative paragraph above the yoga cards', () => {
    const data = yogasData({
      yogaNarrative: ['The yogas of this chart cohere.', 'They point one way.'],
    });
    render(<ReportPdfYogas data={data} />);
    expect(screen.getByText('The yogas of this chart cohere.')).toBeTruthy();
    expect(screen.getByText('They point one way.')).toBeTruthy();
  });

  it('degrades cleanly when the woven narrative is absent', () => {
    render(<ReportPdfYogas data={yogasData()} />);
    expect(screen.getByText('Gaja Kesari Yoga')).toBeTruthy();
  });
});
