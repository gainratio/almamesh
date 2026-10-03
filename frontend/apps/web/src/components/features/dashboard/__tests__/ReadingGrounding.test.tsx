import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { findLaymanJargon } from '@almamesh/llm/layman-jargon';

import '../../../../i18n/config';
import enDashboard from '../../../../locales/en/dashboard.json';
import esDashboard from '../../../../locales/es/dashboard.json';
import ptDashboard from '../../../../locales/pt/dashboard.json';
import { ReadingGrounding } from '../ReadingGrounding';

/**
 * The grounding explainer computes NO astrology and makes NO LLM call — it is
 * pure, static, i18n-driven trust copy. These tests assert the anti-scam
 * integrity story: it is quiet (closed by default), reachable (expands in
 * place), and honest (the deterministic-on-device, externally-validated,
 * grounded-narration points survive).
 */
describe('ReadingGrounding', () => {
  it('renders the affordance, collapsed by default', () => {
    render(<ReadingGrounding />);

    const root = screen.getByTestId('reading-grounding');
    expect(root).toBeTruthy();
    // The reusable Disclosure primitive is a real <button> trigger.
    const trigger = within(root).getByRole('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('carries a self-explanatory summary line', () => {
    render(<ReadingGrounding />);
    expect(screen.getByText(/how this reading is made/i)).toBeTruthy();
  });

  it('expands in place on click to reveal the grounding copy', () => {
    render(<ReadingGrounding />);

    const root = screen.getByTestId('reading-grounding');
    const trigger = within(root).getByRole('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the honest, factual grounding points', () => {
    render(<ReadingGrounding />);

    const text = screen.getByTestId('reading-grounding').textContent ?? '';
    // Deterministic, on-device astronomy.
    expect(text).toContain('on your device');
    expect(text).toContain('deterministic');
    // Externally validated against the JPL ephemeris.
    expect(text).toContain('JPL');
    // Grounded narration, not a generic pre-written horoscope.
    expect(text.toLowerCase()).toContain('horoscope');
    // Privacy: nothing about the chart leaves the device.
    expect(text.toLowerCase()).toContain('redacted');
  });

  it('makes NO accuracy superlative about the AI model (anti-scam voice)', () => {
    render(<ReadingGrounding />);

    const text = (screen.getByTestId('reading-grounding').textContent ?? '').toLowerCase();
    expect(text).not.toContain('most accurate');
    expect(text).not.toContain('best ai');
  });

  // The explainer is mounted INSIDE the reading section, so "For You" readers
  // see it too. It must keep the plain-language promise in every language
  // (the nightly dual-voice gate failed on its "your lagna, ... dashā and yogas").
  it.each([
    ['en', enDashboard],
    ['es', esDashboard],
    ['pt', ptDashboard],
  ])('uses no astrology jargon (%s)', (_lang, locale) => {
    expect(findLaymanJargon(Object.values(locale.grounding).join(' '))).toEqual([]);
  });
});
