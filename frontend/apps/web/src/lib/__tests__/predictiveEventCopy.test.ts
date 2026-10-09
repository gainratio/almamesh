import { describe, it, expect } from 'vitest';
import type { PlanetName, TransitTimelineEventData, ZodiacSign } from '@almamesh/shared-types';
import i18n from '../../i18n/config';
import {
  domainWindowLabel,
  grahaName,
  signName,
  slowHitTargetLabel,
  timelineEventLabel,
} from '../predictiveEventCopy';
import { TRANSIT_CTX, DOMAINS_CTX } from '../../test/predictiveFixtures';

const t = i18n.getFixedT('en');

describe('grahaName / signName', () => {
  it('localizes engine tokens', () => {
    expect(grahaName(t, 'saturn')).toBe('Saturn');
    expect(signName(t, 'aquarius')).toBe('Aquarius');
  });

  it('falls back to Title-Case for unknown tokens (verbatim, never invented)', () => {
    expect(grahaName(t, 'chiron')).toBe('Chiron');
  });
});

describe('timelineEventLabel', () => {
  it('renders a sign ingress as "<graha> enters <sign>"', () => {
    const ingress = TRANSIT_CTX.timeline.events[0];
    expect(timelineEventLabel(t, ingress)).toBe('Jupiter enters Cancer');
  });

  it('renders a dasha change with both lords', () => {
    const change = TRANSIT_CTX.timeline.events[1];
    expect(timelineEventLabel(t, change)).toContain('Mercury');
    expect(timelineEventLabel(t, change)).toContain('Ketu');
  });

  it('degrades to the raw engine descriptor when fields are missing', () => {
    const broken = { ...TRANSIT_CTX.timeline.events[0], graha: null };
    expect(timelineEventLabel(t, broken)).toBe('jupiter.ingress.cancer');
  });

  const station = {
    ...TRANSIT_CTX.timeline.events[0],
    kind: 'station',
    graha: 'saturn',
    from_sign: null,
    to_sign: null,
    station_direction: 'retrograde',
    station_sign: 'pisces',
    descriptor: 'saturn.station.retrograde',
  } as const;

  it('renders a station with its direction and sign, in every language', () => {
    expect(timelineEventLabel(t, station)).toBe('Saturn turns retrograde in Pisces');
    expect(timelineEventLabel(t, { ...station, station_direction: 'direct' })).toBe('Saturn turns direct in Pisces');
    expect(timelineEventLabel(i18n.getFixedT('es'), station)).toBe('Saturno inicia su movimiento retrógrado en Piscis');
    expect(timelineEventLabel(i18n.getFixedT('pt'), station)).toBe('Saturno fica retrógrado em Peixes');
  });

  // Inverted (northstar N3): this used to assert "Jupiter enters Cancer" for a
  // Leo -> Cancer change. A backward sign change now reads "moves back into".
  const ingress = (
    from_sign: ZodiacSign,
    to_sign: ZodiacSign,
    graha: PlanetName = 'jupiter',
  ): TransitTimelineEventData => ({
    ...TRANSIT_CTX.timeline.events[0]!,
    graha,
    from_sign,
    to_sign,
    descriptor: `${graha}.ingress.${to_sign}`,
  });

  it.each([
    ['en', 'leo', 'cancer', 'Jupiter moves back into Cancer'],
    ['es', 'leo', 'cancer', 'Júpiter retrocede a Cáncer'],
    ['pt', 'leo', 'cancer', 'Júpiter retrocede para Câncer'],
    ['en', 'aries', 'pisces', 'Jupiter moves back into Pisces'],
    ['es', 'aries', 'pisces', 'Júpiter retrocede a Piscis'],
    ['pt', 'aries', 'pisces', 'Júpiter retrocede para Peixes'],
  ] as const)('renders a backward sign change in %s: %s -> %s reads "%s"', (language, from, to, expected) => {
    expect(timelineEventLabel(i18n.getFixedT(language), ingress(from, to))).toBe(expected);
  });

  // Rahu and Ketu (mean node) always move backward through the zodiac, so their
  // ordinary sign change is not a return: it keeps "enters".
  it.each([
    ['en', 'rahu', 'aquarius', 'capricorn', 'Rahu enters Capricorn'],
    ['es', 'ketu', 'leo', 'cancer', 'Ketu entra en Cáncer'],
    ['pt', 'rahu', 'aries', 'pisces', 'Rahu entra em Peixes'],
  ] as const)('keeps a node sign change as "enters" in %s (%s %s -> %s)', (language, graha, from, to, expected) => {
    expect(timelineEventLabel(i18n.getFixedT(language), ingress(from, to, graha))).toBe(expected);
  });

  it.each([
    ['en', 'pisces', 'aries', 'Jupiter enters Aries'],
    ['es', 'pisces', 'aries', 'Júpiter entra en Aries'],
    ['pt', 'pisces', 'aries', 'Júpiter entra em Áries'],
    ['en', 'gemini', 'cancer', 'Jupiter enters Cancer'],
  ] as const)('keeps a forward sign change as "enters" in %s: %s -> %s', (language, from, to, expected) => {
    expect(timelineEventLabel(i18n.getFixedT(language), ingress(from, to))).toBe(expected);
  });

  it('a station without its direction keeps the plain line', () => {
    expect(timelineEventLabel(t, { ...station, station_direction: null })).toBe('Saturn stations');
  });
});

describe('domainWindowLabel', () => {
  it('recovers the ingress sign from the stable descriptor key', () => {
    const window = DOMAINS_CTX.forecasts.career.upcoming_windows[0];
    expect(domainWindowLabel(t, window)).toBe('Jupiter enters Cancer');
  });

  it('renders a dasha window from its trigger', () => {
    const window = DOMAINS_CTX.forecasts.career.upcoming_windows[1];
    expect(domainWindowLabel(t, window)).toContain('Ketu');
  });
});

describe('slowHitTargetLabel', () => {
  it('maps the open natal-point vocabulary', () => {
    expect(slowHitTargetLabel(t, 'moon')).toBe('natal Moon');
    expect(slowHitTargetLabel(t, 'lagna')).toBe('Lagna');
    expect(slowHitTargetLabel(t, 'natal_saturn')).toBe('natal Saturn');
  });
});
