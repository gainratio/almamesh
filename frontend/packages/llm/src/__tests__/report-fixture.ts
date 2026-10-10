import type { SiderealChart } from "@almamesh/browser/types";

import chartGolden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import predictiveGolden from "../../../../../backend/tests/fixtures/predictive_golden_de421.json";
import { sanitizeChartForLlm, type AnalysisInstant, type SanitizedChart } from "../sanitize";

const KEY = "1990-01-15T12:00:00+00:00";
const natal = (chartGolden as Record<string, SiderealChart>)[KEY];
const predictive = (predictiveGolden as unknown as Record<string, Partial<SiderealChart>>)[KEY];

/** The engine golden chart with its predictive contexts, as the app holds it. */
export const REPORT_RAW_CHART: SiderealChart = { ...natal, ...predictive };
/** The predictive golden's own instant (2026-06-09T12:00Z), so dashas and transits agree. */
export const REPORT_AS_OF: AnalysisInstant = { basis: "chart", instant: new Date("2026-06-09T12:00:00Z") };
export const REPORT_CHART: SanitizedChart = sanitizeChartForLlm(REPORT_RAW_CHART, REPORT_AS_OF);
