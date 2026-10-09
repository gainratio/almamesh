// A synthetic dasha tree for someone born 2000-03-15. The dates are made up
// for selection tests; they are NOT engine output. The first maha and its
// first antar both start at the birth instant, exactly as the engine emits
// them (calculations.py `_subdivide_period` starts at the parent's start).
import type { DashaPeriod, SiderealChart, VimshottariDasha } from "@almamesh/browser/types";

export const BIRTH_2000_START = "2000-03-15T04:30:00Z";

function row(lord: string, start: string, end: string, years: number): DashaPeriod {
  return { lord, start_date: start, end_date: end, duration_years: years };
}

const MOON_ANTAR = row("moon", "2022-01-15T00:00:00Z", "2023-09-15T00:00:00Z", 1.67);

export const BIRTH_2000_DASHAS: VimshottariDasha = {
  maha_dasha_sequence: [
    {
      ...row("mercury", BIRTH_2000_START, "2010-09-15T00:00:00Z", 10.5),
      antar_sequence: [
        row("mercury", BIRTH_2000_START, "2001-11-20T00:00:00Z", 1.68),
        row("ketu", "2001-11-20T00:00:00Z", "2002-07-01T00:00:00Z", 0.61),
        row("venus", "2002-07-01T00:00:00Z", "2004-05-01T00:00:00Z", 1.75),
      ],
    },
    {
      ...row("ketu", "2010-09-15T00:00:00Z", "2017-09-15T00:00:00Z", 7),
      antar_sequence: [
        row("ketu", "2010-09-15T00:00:00Z", "2011-02-11T00:00:00Z", 0.41),
        row("venus", "2011-02-11T00:00:00Z", "2012-04-11T00:00:00Z", 1.17),
      ],
    },
    {
      ...row("venus", "2017-09-15T00:00:00Z", "2037-09-15T00:00:00Z", 20),
      antar_sequence: [
        row("venus", "2017-09-15T00:00:00Z", "2021-01-15T00:00:00Z", 3.33),
        row("sun", "2021-01-15T00:00:00Z", "2022-01-15T00:00:00Z", 1),
        MOON_ANTAR,
      ],
    },
  ],
  current_maha: row("venus", "2017-09-15T00:00:00Z", "2037-09-15T00:00:00Z", 20),
  current_antar: MOON_ANTAR,
  current_pratyantar: row("rahu", "2022-04-25T00:00:00Z", "2022-08-15T00:00:00Z", 0.3),
  pratyantar_sequence: [
    row("moon", "2022-01-15T00:00:00Z", "2022-03-15T00:00:00Z", 0.14),
    row("mars", "2022-03-15T00:00:00Z", "2022-04-25T00:00:00Z", 0.1),
    row("rahu", "2022-04-25T00:00:00Z", "2022-08-15T00:00:00Z", 0.3),
  ],
};

export const BIRTH_2000_CHART = {
  ayanamsa_value: 23.85,
  lagna: { sign: "aries" },
  planets: [],
  houses: [],
  yogas: [],
  dashas: BIRTH_2000_DASHAS,
} as unknown as SiderealChart;
