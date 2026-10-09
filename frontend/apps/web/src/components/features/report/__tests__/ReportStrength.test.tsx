/**
 * ReportStrength — SAV grid + BAV bindu matrix + six-component Ṣaḍbala.
 *
 * Contract: the BAV matrix prints each emitted graha's per-sign bindus and its
 * total verbatim; the Ṣaḍbala table carries ALL six classical components
 * (Sthāna/Dig/Kāla/Cheṣṭā/Naisargika/Dṛk in virūpas) beside the rūpa totals —
 * every number through the shared two-decimal strength formatter (a raw
 * 6.128260954302394 must never leak into print).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import '../../../../i18n/config';
import { ReportStrength } from '../ReportStrength';
import { STRENGTH_CTX } from '../../../../test/predictiveFixtures';

describe('ReportStrength — printed Ashtakavarga + Shadbala', () => {
  it('renders the SAV grid with all 12 signs and the canonical total', () => {
    render(<ReportStrength strengthCtx={STRENGTH_CTX} />);
    const grid = screen.getByTestId('report-sav-grid');
    expect(grid.querySelectorAll('.report-sign-cell')).toHaveLength(12);
    expect(screen.getByTestId('report-strength').textContent).toContain('337');
  });

  it('prints the BAV bindu matrix: per-sign bindus + totals per emitted graha', () => {
    render(<ReportStrength strengthCtx={STRENGTH_CTX} />);
    const table = screen.getByTestId('report-bav');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(14); // header + 12 signs + totals
    // Header carries the emitted grahas (fixture: Jupiter before Saturn in
    // canonical order).
    expect(rows[0].textContent).toContain('Jupiter');
    expect(rows[0].textContent).toContain('Saturn');
    // Aries row: jupiter 5, saturn 3 (fixture values, verbatim).
    const aries = rows[1];
    expect(aries.textContent).toContain('Aries');
    expect(within(aries).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'Aries', '5', '3',
    ]);
    // Totals row: 56 (jupiter) and 39 (saturn).
    const totals = screen.getByTestId('report-bav-totals');
    expect(within(totals).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'Total', '56', '39',
    ]);
  });

  it('prints all six Ṣaḍbala components in virūpas beside the rūpa totals', () => {
    render(<ReportStrength strengthCtx={STRENGTH_CTX} />);
    const table = screen.getByTestId('report-shadbala');
    const header = within(table).getAllByRole('row')[0];
    for (const col of ['Sthāna', 'Dig', 'Kāla', 'Cheṣṭā', 'Naisargika', 'Dṛk']) {
      expect(header.textContent).toContain(col);
    }
    const saturnRow = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Saturn'));
    expect(saturnRow).toBeTruthy();
    const cells = within(saturnRow as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    // sthana 165 · dig 28 · kala 169 · cheshta 33 · naisargika 8.57 · drik −4.2,
    // then rupa total/required — all via the shared two-decimal formatter.
    expect(cells).toContain('165.00');
    expect(cells).toContain('28.00');
    expect(cells).toContain('169.00');
    expect(cells).toContain('33.00');
    expect(cells).toContain('8.57');
    expect(cells).toContain('-4.20');
    expect(cells).toContain('6.13'); // 6.128260954302394 formatted — never raw
    expect(saturnRow?.textContent).not.toContain('6.128260954302394');
    expect(saturnRow?.textContent).toContain('Meets minimum');
  });

  it('marks the below-minimum graha honestly', () => {
    render(<ReportStrength strengthCtx={STRENGTH_CTX} />);
    const jupiterRow = within(screen.getByTestId('report-shadbala'))
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Jupiter'));
    expect(jupiterRow?.textContent).toContain('Below minimum');
  });
});

describe('ReportStrength — the Kalabala sunrise is printed in the birthplace zone', () => {
  it('prints the sunrise on the birthplace calendar and clock, naming the zone', () => {
    // 1990-01-15T01:12Z is 06:42 on Jan 15 in Kolkata (and Jan 14 west of UTC).
    render(<ReportStrength strengthCtx={STRENGTH_CTX} birthTimeZone="Asia/Kolkata" />);
    const note = screen.getByTestId('report-sunrise-basis').textContent ?? '';
    expect(note).toMatch(/Jan 15, 1990/);
    expect(note).toMatch(/6:42/);
    expect(note).toMatch(/Asia\/Kolkata/);
  });
});

