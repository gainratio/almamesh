import {
  compose,
  type MinimumRequest,
  type ScoreResult,
} from "@gainratio/assay";

import type {
  LifeDomainsContext,
  StrengthSummary,
} from "./predictive";

export type DomainStrengthAssayResult = ScoreResult;

const PERCENT_SCALE = {
  minimum: 0,
  maximum: 100,
  direction: "higher_is_better",
} as const;

function request(summary: StrengthSummary): MinimumRequest {
  return {
    method: "minimum",
    method_version: "almamesh.domain-strength.v1",
    components: [
      {
        id: "shadbala_pct",
        label: "Shadbala strength",
        value: summary.shadbala_pct,
        scale: PERCENT_SCALE,
        interval: null,
        weight: null,
      },
      {
        id: "sav_pct",
        label: "Sarvashtakavarga strength",
        value: summary.sav_pct,
        scale: PERCENT_SCALE,
        interval: null,
        weight: null,
      },
    ],
    clamp: "reject",
  };
}

export function composeDomainStrength(summary: StrengthSummary): DomainStrengthAssayResult {
  const result = compose(request(summary));
  const selected = result.components.find(
    (component) => component.id === result.selected_component_id,
  );
  if (selected?.raw !== summary.strength_pct) {
    throw new Error("Engine headline does not match Assay minimum");
  }
  return result;
}

export function composeDomainStrengths(
  domains: LifeDomainsContext,
): Record<string, DomainStrengthAssayResult> {
  return Object.fromEntries(
    Object.entries(domains.forecasts).map(([domain, forecast]) => [
      domain,
      composeDomainStrength(forecast.strength_summary),
    ]),
  );
}
