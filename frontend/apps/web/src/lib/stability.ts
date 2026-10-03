/**
 * Stable-vs-lagna markers — the TS mirror of `almamesh.rectification.stability`.
 *
 * A {@link StabilityMarker} is a deterministic FACT about ONE report claim (a
 * yoga or a life domain): does its verdict survive BOTH candidate ascendants
 * that birth-time rectification could pick? `holdsUnderBoth: true` = "birth-time
 * stable" (the verdict does not depend on the exact birth time); `false` =
 * "birth-time sensitive". It is honestly certain — a comparison of two charts,
 * never a model estimate.
 *
 * Two ways to build markers, both pure:
 *   • {@link diffMarkers} — the exact diff (mirror of the Python `yoga_markers`
 *     / `domain_markers`): a verdict is stable iff present in BOTH candidate
 *     charts and identical. Used when the alternate-lagna verdicts are in hand.
 *   • {@link reportStabilityMarkers} — the RENDER-TIME conservative default: the
 *     report is computed for ONE lagna, so when that lagna sits on a sign cusp
 *     (a live alternate ascendant, whole-sign houses would rotate) each claim
 *     carrying house-dependency metadata is flagged birth-time-sensitive;
 *     sign-only claims remain stable. It never claims a stability it cannot back.
 *
 * The claim-id format (`yoga:<name>` / `domain:<domain>`) is byte-identical to
 * the Python module, so a future live dual pass can feed either producer.
 */

/** One report claim's birth-time stability — mirror of the Python model. */
export interface StabilityMarker {
  /** Namespaced claim id: `yoga:<name>` or `domain:<domain>`. */
  readonly claimId: string;
  /** True iff the verdict is identical under both candidate ascendants. */
  readonly holdsUnderBoth: boolean;
}

/** The only dependency fact the conservative render-time marker needs. */
export interface ReportStabilityClaim {
  readonly claimId: string;
  readonly houseDependent: boolean;
}

/** Namespaced stability id for a yoga claim (mirror of `yoga_claim_id`). */
export function yogaClaimId(name: string): string {
  return `yoga:${name}`;
}

/** Namespaced stability id for a life-domain claim (mirror of `domain_claim_id`). */
export function domainClaimId(domain: string): string {
  return `domain:${domain}`;
}

/**
 * The exact diff: a claim is stable iff its verdict is present in BOTH maps and
 * equal. Keys ARE claim ids. Output is sorted by claim id for determinism —
 * byte-identical semantics to the Python `yoga_markers` / `domain_markers`.
 */
export function diffMarkers<V>(
  primary: ReadonlyMap<string, V>,
  alternate: ReadonlyMap<string, V>,
): StabilityMarker[] {
  const claimIds = new Set<string>([...primary.keys(), ...alternate.keys()]);
  return [...claimIds].sort().map((claimId) => ({
    claimId,
    holdsUnderBoth:
      primary.has(claimId) && alternate.has(claimId) && primary.get(claimId) === alternate.get(claimId),
  }));
}

/**
 * The render-time conservative markers for a report computed at ONE lagna.
 * `nearCusp` = the ascendant sits within the cusp threshold, so an adjacent-sign
 * ascendant is a live alternative and every house-dependent verdict is birth-
 * time-sensitive; otherwise the ascendant is unambiguous and every verdict is stable.
 */
export function reportStabilityMarkers(
  claims: readonly ReportStabilityClaim[],
  nearCusp: boolean,
): Map<string, StabilityMarker> {
  const markers = new Map<string, StabilityMarker>();
  for (const claim of claims) {
    markers.set(claim.claimId, {
      claimId: claim.claimId,
      holdsUnderBoth: !nearCusp || !claim.houseDependent,
    });
  }
  return markers;
}
