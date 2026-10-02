/**
 * narrationOutage — the AI narration is an OPTIONAL enhancement, so the ways it
 * can be unavailable must map to calm, mode-specific copy rather than one red
 * "it failed" block. These tests pin the mapping: which typed failures degrade
 * gracefully, and which ones are genuine faults that keep a louder treatment.
 */
import { describe, expect, it } from 'vitest';

import { narrationOutage } from './narrationOutage';

describe('narrationOutage', () => {
  it('maps an exhausted balance to its own out-of-credits mode', () => {
    expect(narrationOutage('credits')).toBe('credits');
  });

  it('maps every provider-side transient failure to one provider-unavailable mode', () => {
    expect(narrationOutage('server')).toBe('provider_down');
    expect(narrationOutage('network')).toBe('provider_down');
    expect(narrationOutage('rate_limited')).toBe('provider_down');
    // A model that thought past the 3-minute cap: retry or a faster model fixes it.
    expect(narrationOutage('reasoning_timeout')).toBe('provider_down');
  });

  it('keeps a rejected key and a retired model as their own actionable modes', () => {
    expect(narrationOutage('auth')).toBe('auth');
    expect(narrationOutage('model')).toBe('model');
  });

  it('treats a genuine defect as a fault, NOT a graceful degradation', () => {
    // A fail-closed privacy refusal, an app-state error, and an unclassified
    // failure are real problems — they keep the stronger treatment.
    expect(narrationOutage('privacy')).toBe('fault');
    expect(narrationOutage('needs_regeneration')).toBe('fault');
    expect(narrationOutage('unknown')).toBe('fault');
  });

  it('treats a legacy entry with no recorded kind as a fault (fail conservative)', () => {
    expect(narrationOutage(null)).toBe('fault');
  });
});
