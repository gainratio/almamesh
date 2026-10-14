import { describe, it, expect } from 'vitest';
import type { VedicInterpretation } from '@almamesh/shared-types';

import {
  LIFE_DOMAINS,
  isLifeDomain,
  nextWindow,
  domainGuidance,
  DOMAIN_GUIDANCE_KEY,
} from '../lifeAtlas';
import { DOMAINS_CTX } from '../../test/predictiveFixtures';

describe('LIFE_DOMAINS', () => {
  it('lists the eight canonical domains in stable order, obstacles last', () => {
    expect(LIFE_DOMAINS).toEqual([
      'career',
      'finances',
      'health',
      'relationships',
      'spiritual',
      'education',
      'family',
      'obstacles',
    ]);
    expect(LIFE_DOMAINS).toHaveLength(8);
  });
});

describe('isLifeDomain', () => {
  it('accepts every canonical domain slug', () => {
    for (const domain of LIFE_DOMAINS) {
      expect(isLifeDomain(domain)).toBe(true);
    }
  });

  it('rejects unknown or mis-cased slugs', () => {
    expect(isLifeDomain('Career')).toBe(false);
    expect(isLifeDomain('money')).toBe(false);
    expect(isLifeDomain('')).toBe(false);
  });
});

describe('nextWindow', () => {
  it('returns the earliest upcoming window by date', () => {
    const career = DOMAINS_CTX.forecasts.career;
    const expected = [...career.upcoming_windows].sort((a, b) =>
      a.date.localeCompare(b.date),
    )[0];
    expect(nextWindow(career)).toEqual(expected);
  });

  it('returns null when the engine emitted no windows', () => {
    const career = DOMAINS_CTX.forecasts.career;
    expect(nextWindow({ ...career, upcoming_windows: [] })).toBeNull();
  });
});

describe('domainGuidance', () => {
  const interpretation: VedicInterpretation = {
    summary: { layman: 'A summary.', technical: 'A summary.' },
    strengths: [],
    challenges: [],
    life_themes: [],
    career_guidance: { layman: 'Steady work suits you.', technical: '10th lord strong.' },
    relationship_guidance: { layman: 'Partnerships deepen.', technical: '7th lord aspected.' },
  };

  it('maps each domain to its structured-interpretation section', () => {
    expect(domainGuidance(interpretation, 'career')?.layman).toBe('Steady work suits you.');
    expect(domainGuidance(interpretation, 'relationships')?.layman).toBe('Partnerships deepen.');
  });

  it('returns null when the section is absent', () => {
    expect(domainGuidance(interpretation, 'health')).toBeNull();
    expect(domainGuidance(undefined, 'career')).toBeNull();
  });

  it('declares family as engine-only (no AI section exists for it)', () => {
    expect(DOMAIN_GUIDANCE_KEY.family).toBeNull();
    expect(domainGuidance(interpretation, 'family')).toBeNull();
  });

  it('declares obstacles as engine-only: no AI section is ever borrowed for it', () => {
    expect(isLifeDomain('obstacles')).toBe(true);
    expect(DOMAIN_GUIDANCE_KEY.obstacles).toBeNull();
    expect(domainGuidance(interpretation, 'obstacles')).toBeNull();
  });

  it('returns null when a section carries no usable text', () => {
    const empty: VedicInterpretation = {
      ...interpretation,
      career_guidance: { layman: '', technical: undefined },
    };
    expect(domainGuidance(empty, 'career')).toBeNull();
  });
});
