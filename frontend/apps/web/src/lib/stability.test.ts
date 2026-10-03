import { describe, expect, it } from 'vitest';
import {
  diffMarkers,
  domainClaimId,
  reportStabilityMarkers,
  yogaClaimId,
  type StabilityMarker,
} from './stability';

describe('stability claim ids mirror the Python contract', () => {
  it('namespaces yoga and domain claims byte-identically', () => {
    expect(yogaClaimId('gaja_kesari')).toBe('yoga:gaja_kesari');
    expect(domainClaimId('career')).toBe('domain:career');
  });
});

describe('diffMarkers — exact stability diff (mirror of yoga_markers/domain_markers)', () => {
  it('is stable iff the verdict is present in both and identical', () => {
    const primary = new Map([
      ['yoga:a', 'strong'],
      ['yoga:b', 'strong'],
    ]);
    const alternate = new Map([
      ['yoga:a', 'strong'], // identical → stable
      ['yoga:b', 'weak'], // differs → sensitive
    ]);
    expect(diffMarkers(primary, alternate)).toEqual<StabilityMarker[]>([
      { claimId: 'yoga:a', holdsUnderBoth: true },
      { claimId: 'yoga:b', holdsUnderBoth: false },
    ]);
  });

  it('flags a claim present under only one lagna as NOT stable', () => {
    const primary = new Map([['yoga:only', 'strong']]);
    const alternate = new Map<string, string>();
    expect(diffMarkers(primary, alternate)).toEqual<StabilityMarker[]>([
      { claimId: 'yoga:only', holdsUnderBoth: false },
    ]);
  });

  it('sorts the union of claim ids for determinism', () => {
    const primary = new Map([
      ['yoga:zebra', 'strong'],
      ['yoga:alpha', 'moderate'],
    ]);
    expect(diffMarkers(primary, primary).map((m) => m.claimId)).toEqual([
      'yoga:alpha',
      'yoga:zebra',
    ]);
  });
});

describe('reportStabilityMarkers — render-time conservative default', () => {
  it('marks every claim STABLE when the lagna is not near a cusp', () => {
    const markers = reportStabilityMarkers(
      [
        { claimId: 'yoga:a', houseDependent: true },
        { claimId: 'domain:career', houseDependent: true },
      ],
      false,
    );
    expect(markers.get('yoga:a')).toEqual({ claimId: 'yoga:a', holdsUnderBoth: true });
    expect(markers.get('domain:career')).toEqual({
      claimId: 'domain:career',
      holdsUnderBoth: true,
    });
  });

  it('marks only HOUSE-DEPENDENT claims sensitive when the lagna is on a cusp', () => {
    const markers = reportStabilityMarkers(
      [
        { claimId: 'yoga:house-based', houseDependent: true },
        { claimId: 'yoga:sign-only', houseDependent: false },
        { claimId: 'domain:career', houseDependent: true },
      ],
      true,
    );
    expect(markers.get('yoga:house-based')?.holdsUnderBoth).toBe(false);
    expect(markers.get('yoga:sign-only')?.holdsUnderBoth).toBe(true);
    expect(markers.get('domain:career')?.holdsUnderBoth).toBe(false);
  });
});
