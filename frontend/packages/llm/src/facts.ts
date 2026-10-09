// Engine facts -> a compact, deterministic, human-readable summary.
//
// This is the single source the chat prompt injects in place of a raw chart JSON
// dump: smaller on the wire (cheaper, faster) and easier for a model to ground
// on. Every value is the engine's OWN number read straight from the already-
// `SanitizedChart` (identifier-free by construction) — NO new astrology math, NO
// derived positions. The model narrates from these lines; it never recomputes.

import type { PlanetPosition } from "@almamesh/browser/types";
import { buildPredictiveFactsBlock } from "./predictive-facts";
import type {
  SanitizedChart,
  SanitizedCurrentPeriod,
  SanitizedDashas,
  SanitizedDatedPeriod,
} from "./sanitize";

/**
 * One planet's line:
 * "mars: capricorn 10.50° (10th house), exalted — nakshatra shravana pada 1 (lord moon)".
 *
 * Spec 062 (LLM delta 4) deliberately REVERSED the earlier degrees/nakshatra
 * exclusion: chat could not ground "what degree is my Mars?" or a nakshatra
 * question without them. Every value is still the engine's OWN emitted field
 * (sign_degrees, nakshatra, nakshatra_pada, nakshatra_lord) — no astrology
 * math, nothing identifying. Legacy stored payloads that predate these fields
 * degrade gracefully (the extras are simply omitted).
 */
function planetLine(planet: PlanetPosition): string {
  const degrees =
    typeof planet.sign_degrees === "number" ? ` ${planet.sign_degrees.toFixed(2)}°` : "";
  const parts = [`${planet.sign}${degrees} (${planet.house}th house)`];
  if (planet.dignity && planet.dignity !== "neutral") {
    parts.push(planet.dignity);
  }
  if (planet.is_retrograde) {
    parts.push("retrograde");
  }
  if (planet.is_combust) {
    parts.push("combust");
  }
  const nakshatra = planet.nakshatra
    ? ` — nakshatra ${planet.nakshatra} pada ${planet.nakshatra_pada} (lord ${planet.nakshatra_lord})`
    : "";
  return `- ${planet.name}: ${parts.join(", ")}${nakshatra}`;
}

/** The planet block: one line per graha, in the chart's own key order. */
function planetBlock(chart: SanitizedChart): string {
  const lines = Object.values(chart.planets).map(planetLine);
  return ["Planets:", ...lines].join("\n");
}

/** One planet's lordship entry, e.g. "saturn rules 10,11 (yogakaraka)", or "". */
function lordshipEntry(planet: PlanetPosition): string {
  // `houses_ruled` / `is_yogakaraka` are required engine fields; an empty
  // lordship list (Rahu/Ketu) contributes no entry.
  if (planet.houses_ruled.length === 0) {
    return "";
  }
  const karaka = planet.is_yogakaraka ? " (yogakaraka)" : "";
  return `${planet.name} rules ${planet.houses_ruled.join(",")}${karaka}`;
}

/** The compact engine-computed lordship line, or "" when the engine emits none. */
function lordshipLine(chart: SanitizedChart): string {
  const entries = Object.values(chart.planets)
    .map(lordshipEntry)
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    return "";
  }
  return `House lordships (engine-computed): ${entries.join("; ")}`;
}

/** A single dasha lord line, or "" when that level is not running. */
function dashaLine(label: string, period: SanitizedCurrentPeriod | null): string {
  if (!period) {
    return "";
  }
  return `- ${label}: ${period.lord} (${period.months_remaining} months remaining)`;
}

const PERIOD_LABEL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * A period in plain English (the prompt language): "1–30 June 2026". ICU puts
 * thin spaces around the range dash and their presence varies by ICU version,
 * so the dash is normalized to keep prompts byte-stable.
 */
export function formatPeriodLabel(start: string, end: string): string {
  return PERIOD_LABEL_FORMAT.formatRange(new Date(`${start}T00:00:00Z`), new Date(`${end}T00:00:00Z`)).replace(
    /\s*–\s*/g,
    "–",
  );
}

function dashaHeader(asOf: SanitizedChart["as_of"]): string {
  if (asOf.basis === "period" && asOf.period_start && asOf.period_end) {
    return `Dasha period as of ${formatPeriodLabel(asOf.period_start, asOf.period_end)} (the period asked about):`;
  }
  const basis = asOf.basis === "today" ? "today" : "the chart's analysis date";
  return `Current dasha period (as of ${asOf.date}, ${basis}):`;
}

/**
 * The current Vimshottari dasha block (maha/antar/pratyantar), if present. Under a
 * period basis the current rows describe the chart's reference date, not the
 * period, so they are omitted (the timing tool result carries the period's dashas).
 */
function dashaBlock(chart: SanitizedChart): string {
  if (!chart.dashas) {
    return "";
  }
  const isPeriod = chart.as_of.basis === "period";
  const lines = (
    isPeriod
      ? []
      : [
          dashaLine("Mahadasha", chart.dashas.current_maha),
          dashaLine("Antardasha", chart.dashas.current_antar),
          dashaLine("Pratyantardasha", chart.dashas.current_pratyantar),
        ]
  ).filter((line) => line !== "");
  if (chart.dashas.convention) {
    // No silent convention: state which dasha-year length built these periods.
    lines.push(`- Dasha-year convention: ${chart.dashas.convention} (engine-declared)`);
  }
  if (isPeriod) {
    lines.unshift("- Current dasha rows omitted: they describe today, not this period; use the timing tool result.");
  }
  const header = dashaHeader(chart.as_of);
  return lines.length > 0 ? [header, ...lines].join("\n") : "";
}

// --- engine-dated period blocks (the dasha tree). Every lord and window below
// is read VERBATIM from the sanitizer's month-precision tree — no date math, no
// derived periods. All of these render "" for charts without the tree, keeping
// legacy facts output byte-identical. ---

/** "lord YYYY-MM -> YYYY-MM" for one engine-dated sequence row. */
function datedSpan(period: SanitizedDatedPeriod): string {
  return `${period.lord} ${period.start_month} -> ${period.end_month}`;
}

/** A dated current-level line, or "" when that level carries no month window. */
function datedCurrentLine(label: string, period: SanitizedCurrentPeriod | null): string {
  if (!period?.start_month || !period.end_month) {
    return "";
  }
  return `- ${label}: ${period.lord} ${period.start_month} -> ${period.end_month}`;
}

/** The engine-dated current stack (maha/antar/pratyantar month windows). */
function datedCurrentBlock(chart: SanitizedChart): string {
  if (!chart.dashas || chart.as_of.basis === "period") {
    return "";
  }
  const lines = [
    datedCurrentLine("Mahadasha", chart.dashas.current_maha),
    datedCurrentLine("Antardasha", chart.dashas.current_antar),
    datedCurrentLine("Pratyantardasha", chart.dashas.current_pratyantar),
  ].filter((line) => line !== "");
  return lines.length > 0 ? ["Current period (engine-dated):", ...lines].join("\n") : "";
}

/** Rows strictly AFTER the row matching `lord` (lords are unique per sequence). */
function rowsAfter<T extends { readonly lord: string }>(
  rows: readonly T[],
  lord: string | undefined,
): readonly T[] {
  if (lord === undefined) {
    return [];
  }
  const idx = rows.findIndex((row) => row.lord === lord);
  return idx === -1 ? [] : rows.slice(idx + 1);
}

/** The remaining antardashas of the current maha, or "" without tree/anchor. */
function remainingAntarsLine(dashas: SanitizedDashas): string {
  const mahaLord = dashas.current_maha?.lord;
  const mahaRow = dashas.maha_dasha_sequence.find((row) => row.lord === mahaLord);
  const remaining = rowsAfter(mahaRow?.antar_sequence ?? [], dashas.current_antar?.lord);
  if (mahaLord === undefined || remaining.length === 0) {
    return "";
  }
  const spans = remaining.map(datedSpan).join("; ");
  return `- Remaining antardashas of the ${mahaLord} mahadasha: ${spans}`;
}

/** The remaining pratyantardashas of the current antar, or "" without them. */
function remainingPratyantarsLine(dashas: SanitizedDashas): string {
  const antarLord = dashas.current_antar?.lord;
  const remaining = rowsAfter(
    dashas.pratyantar_sequence ?? [],
    dashas.current_pratyantar?.lord,
  );
  if (antarLord === undefined || remaining.length === 0) {
    return "";
  }
  const spans = remaining.map(datedSpan).join("; ");
  return `- Remaining pratyantardashas of the ${antarLord} antardasha: ${spans}`;
}

/** The next mahadasha's dated window, or "" when last/undated. */
function nextMahaLine(dashas: SanitizedDashas): string {
  const next = rowsAfter(dashas.maha_dasha_sequence, dashas.current_maha?.lord)[0];
  if (!next?.start_month || !next.end_month) {
    return "";
  }
  return `- Next mahadasha: ${next.lord} ${next.start_month} -> ${next.end_month}`;
}

/**
 * The engine-dated upcoming periods: the remaining antardashas of the current
 * maha, the remaining pratyantardashas of the current antar, and the next maha.
 */
function upcomingPeriodsBlock(chart: SanitizedChart): string {
  // These derive from the current rows, which describe today, so a period basis omits them.
  if (!chart.dashas || chart.as_of.basis === "period") {
    return "";
  }
  const lines = [
    remainingAntarsLine(chart.dashas),
    remainingPratyantarsLine(chart.dashas),
    nextMahaLine(chart.dashas),
  ].filter((line) => line !== "");
  return lines.length > 0 ? ["Upcoming periods (engine-dated):", ...lines].join("\n") : "";
}

/** The D9 Navamsa block (engine-computed divisional signs), if present. */
function navamsaBlock(chart: SanitizedChart): string {
  if (!chart.navamsa) {
    return "";
  }
  const lagna = `- Lagna: ${chart.navamsa.lagna_sign} (lord ${chart.navamsa.lagna_sign_lord})`;
  const planetLines = Object.values(chart.navamsa.planets).map(
    (p) => `- ${p.name}: ${p.sign} (lord ${p.sign_lord})`,
  );
  return ["D9 Navamsa (engine-computed divisional chart):", lagna, ...planetLines].join("\n");
}

/**
 * One yoga line, engine words only:
 * "- Gaja Kesari Yoga (…) [moderate] (planets: jupiter, moon) — basis: Jupiter
 *  in the 1st from the Moon". The grade is the engine's qualitative grade. The
 * contract DOES carry a numeric `strength_pct`, and the report prints it — but
 * this fact sheet deliberately withholds it, so the model can never re-weight or
 * re-derive a number the reader can already check against the engine. The basis
 * is the first formation rule's own description (guarded for older payloads).
 */
function yogaLine(yoga: SanitizedChart["yogas"][number]): string {
  const title = yoga.display_name || yoga.name;
  const planets = yoga.planets_involved.join(", ");
  const firstRule = yoga.formation_rules[0];
  const basis = firstRule ? ` — basis: ${firstRule.description}` : "";
  return `- ${title} [${yoga.grade}] (planets: ${planets})${basis}`;
}

/** The detected-yogas block, if any yogas were found. */
function yogaBlock(chart: SanitizedChart): string {
  if (chart.yogas.length === 0) {
    return "";
  }
  return ["Detected yogas:", ...chart.yogas.map(yogaLine)].join("\n");
}

/** The ascendant (lagna) line. */
function lagnaLine(chart: SanitizedChart): string {
  return `Ascendant (Lagna): ${chart.lagna.sign}, lord ${chart.lagna.sign_lord}`;
}

/**
 * Build a compact, deterministic facts summary from a SANITIZED chart.
 *
 * Reuses the engine's own emitted fields verbatim. The `SanitizedChart` type at
 * the boundary keeps this on the privacy-safe side: only identifier-free,
 * date-relativized astrology can reach the returned string.
 */
export function buildChartFactsBlock(chart: SanitizedChart): string {
  return [
    lagnaLine(chart),
    planetBlock(chart),
    // Engine-computed per-planet house lordships ("" until the engine emits
    // houses_ruled — graceful absence keeps the block byte-identical to today).
    lordshipLine(chart),
    dashaBlock(chart),
    // Engine-dated current stack + upcoming periods ("" without the dasha
    // tree — legacy charts keep byte-identical output).
    datedCurrentBlock(chart),
    upcomingPeriodsBlock(chart),
    navamsaBlock(chart),
    yogaBlock(chart),
    // The delimited engine predictive block ("" when no contexts are present,
    // keeping the output byte-identical to the natal-only facts).
    // Under a period basis it would be today's sky labelled as the period: the
    // timing tool result carries the period's own sky instead.
    chart.as_of.basis === "period" ? "" : buildPredictiveFactsBlock(chart.predictive),
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}
