// Sanitized predictive contexts -> one compact, clearly delimited facts block.
//
// Same philosophy as ./facts.ts: every value is the engine's OWN figure read
// straight from the already-sanitized `SanitizedPredictive` (month-precision
// dates, identifier-free by construction) — NO new astrology math. The block is
// wrapped in explicit delimiters with narrate-only guard language so the model
// treats it exactly like the chart JSON: quote it, never extrapolate beyond it.

import type {
  SanitizedDomainForecast,
  SanitizedFusion,
  SanitizedGocharaPlacement,
  SanitizedPredictive,
  SanitizedSadeSati,
  SanitizedSlowHit,
  SanitizedStrength,
  SanitizedTransitEvent,
  SanitizedTransits,
  SanitizedVargaSummary,
} from "./sanitize";

export const PREDICTIVE_BLOCK_START =
  "=== ENGINE PREDICTIVE CONTEXT (deterministic engine output) ===";
export const PREDICTIVE_BLOCK_END = "=== END ENGINE PREDICTIVE CONTEXT ===";

// The guard the model reads FIRST: this block is engine truth, and its
// month-precision windows are the ONLY dates that exist.
const PREDICTIVE_GUARD = [
  "Narrate ONLY what this block states. Its month-precision windows (e.g.",
  "2030-03) are the ONLY dates you may cite — quote them verbatim, never",
  "extrapolate beyond them, and never invent any other date, age, year, or",
  "transit. Where this block is silent, say nothing.",
].join("\n");

/** "saturn: pisces — house 12 from Lagna, house 8 from Moon, retrograde". */
function gocharaLine(p: SanitizedGocharaPlacement): string {
  const retro = p.is_retrograde ? ", retrograde" : "";
  return `- ${p.graha}: ${p.sign} — house ${p.house_from_lagna} from Lagna, house ${p.house_from_moon} from Moon${retro}`;
}

function sadeSatiLine(s: SanitizedSadeSati): string {
  if (!s.is_active) {
    return `- Sade Sati: not active (natal Moon sign ${s.natal_moon_sign})`;
  }
  const until = s.until_month ? `, until about ${s.until_month}` : "";
  return `- Sade Sati: ACTIVE — phase ${s.current_phase} (natal Moon sign ${s.natal_moon_sign}${until})`;
}

function fusionLine(f: SanitizedFusion): string {
  const antar = f.antar_lord ? `, antar lord ${f.antar_lord}` : "";
  const reinforcing = f.reinforcing.length > 0 ? `; reinforcing: ${f.reinforcing.join(", ")}` : "";
  const afflicting = f.afflicting.length > 0 ? `; afflicting: ${f.afflicting.join(", ")}` : "";
  return (
    `- Dasha-transit fusion: maha lord ${f.maha_lord}${antar} transits house ` +
    `${f.maha_lord_transit_house_from_moon} from Moon / house ` +
    `${f.maha_lord_transit_house_from_lagna} from Lagna` +
    `${reinforcing}${afflicting}; net severity ${f.severity}`
  );
}

function slowHitLine(hit: SanitizedSlowHit): string {
  return `- ${hit.graha} ${hit.kind} on natal ${hit.natal_point} around ${hit.month} (${hit.severity})`;
}

function timelineLine(event: SanitizedTransitEvent): string {
  const graha = event.graha ? ` — ${event.graha}` : "";
  const signs =
    event.from_sign && event.to_sign ? ` ${event.from_sign} -> ${event.to_sign}` : "";
  return `- ${event.month}: ${event.kind}${graha}${signs} (${event.severity}): ${event.descriptor}`;
}

function transitsSection(transits: SanitizedTransits): string {
  const lines = [
    "Current transits (Gochara):",
    ...transits.gochara.map(gocharaLine),
    sadeSatiLine(transits.sade_sati),
    fusionLine(transits.fusion),
    ...transits.slow_hits.map(slowHitLine),
  ];
  if (transits.timeline.length > 0) {
    lines.push("Upcoming transit windows (month precision):");
    lines.push(...transits.timeline.map(timelineLine));
  }
  return lines.join("\n");
}

function shadbalaLine(line: SanitizedStrength["shadbala"][number]): string {
  const meets = line.meets_minimum ? "meets minimum" : "below minimum";
  return `${line.planet} ${line.total_rupas} rupas (required ${line.required_rupas}, ${meets})`;
}

function strengthSection(strength: SanitizedStrength): string {
  const lines = [
    "Strength figures (engine-computed):",
    `- Sarvashtakavarga (SAV) total: ${strength.sav_total} bindus`,
  ];
  if (strength.shadbala.length > 0) {
    lines.push(`- Shadbala: ${strength.shadbala.map(shadbalaLine).join("; ")}`);
  }
  return lines.join("\n");
}

function vargaSection(vargas: SanitizedVargaSummary): string {
  const lines = ["Divisional-chart (varga) summaries:"];
  if (vargas.vargottama.length > 0) {
    const flags = vargas.vargottama.map((v) => `${v.point} in ${v.sign}`).join("; ");
    lines.push(`- Vargottama (same sign in D1 and D9): ${flags}`);
  }
  for (const own of vargas.shadvarga_own_sign) {
    lines.push(
      `- Shadvarga own-sign: ${own.graha} in own sign in ${own.own_sign_count} charts (${own.charts_in_own_sign.join(", ")})`,
    );
  }
  if (vargas.vimshopaka.length > 0) {
    const scores = vargas.vimshopaka
      .map((v) => `${v.graha} ${v.score}${v.approximated ? " (approximated)" : ""}`)
      .join("; ");
    lines.push(`- Vimshopaka bala: ${scores}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function domainWindowLine(window: SanitizedDomainForecast["windows"][number]): string {
  const trigger = window.trigger ? ` via ${window.trigger}` : "";
  return `  - ${window.month}: ${window.source} ${window.kind}${trigger} (${window.severity}): ${window.descriptor}`;
}

function domainEmphasisLine(forecast: SanitizedDomainForecast): string {
  const dasha = forecast.active_dasha_significator
    ? `dasha significator ACTIVE (${forecast.dasha_levels.join("+")}: ${forecast.matched_dasha_lords.join(", ")})`
    : "no active dasha significator";
  const sadeSati = forecast.under_sade_sati ? "; under Sade Sati" : "";
  return `  current emphasis: ${dasha}${sadeSati}; transit severity ${forecast.transit_severity}`;
}

function domainLines(forecast: SanitizedDomainForecast): string[] {
  const meets = forecast.key_graha_meets_minimum ? "meets minimum" : "below minimum";
  const note = forecast.strength_note ? ` ${forecast.strength_note}` : "";
  return [
    `- ${forecast.domain} — strength band: ${forecast.band} (key graha ${forecast.key_graha}, ` +
      `${forecast.key_graha_rupas} rupas, ${meets}; SAV ${forecast.sav_bindus} bindus).${note}`,
    domainEmphasisLine(forecast),
    ...forecast.windows.map(domainWindowLine),
  ];
}

function domainsSection(domains: readonly SanitizedDomainForecast[]): string {
  return ["Life-domain forecasts:", ...domains.flatMap(domainLines)].join("\n");
}

/**
 * Serialize the sanitized predictive contexts into ONE delimited facts block,
 * or "" when none are present — so prompts without predictive data stay
 * byte-identical to the pre-predictive output.
 */
export function buildPredictiveFactsBlock(predictive?: SanitizedPredictive): string {
  if (!predictive) {
    return "";
  }
  const sections = [
    predictive.transits ? transitsSection(predictive.transits) : "",
    predictive.strength ? strengthSection(predictive.strength) : "",
    predictive.vargas ? vargaSection(predictive.vargas) : "",
    predictive.domains && predictive.domains.length > 0
      ? domainsSection(predictive.domains)
      : "",
  ].filter((section) => section !== "");
  if (sections.length === 0) {
    return "";
  }
  return [PREDICTIVE_BLOCK_START, PREDICTIVE_GUARD, "", sections.join("\n\n"), PREDICTIVE_BLOCK_END].join(
    "\n",
  );
}

export const REPORT_FACTS_START = "=== ENGINE REPORT FACTS (deterministic engine output) ===";
export const REPORT_FACTS_END = "=== END ENGINE REPORT FACTS ===";

/** One report section's engine slice (report-sections.ts) as a delimited, narrate-only block. */
export function buildReportFactsBlock(slice: object): string {
  return [REPORT_FACTS_START, PREDICTIVE_GUARD, "", JSON.stringify(slice), REPORT_FACTS_END].join("\n");
}
