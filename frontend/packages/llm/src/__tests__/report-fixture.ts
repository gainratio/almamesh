import type { SiderealChart } from "@almamesh/browser/types";

import chartGolden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import predictiveGolden from "../../../../../backend/tests/fixtures/predictive_golden_de421.json";
import { sanitizeChartForLlm, type AnalysisInstant, type SanitizedChart } from "../sanitize";
import natalAtPredictiveInstant from "./report-natal-at-predictive-instant.json";

const KEY = "1990-01-15T12:00:00+00:00";
const natal = (chartGolden as Record<string, SiderealChart>)[KEY];
const predictive = (predictiveGolden as unknown as Record<string, Partial<SiderealChart>>)[KEY];

// The natal golden is stamped at reference_date 2025-01-01 and the predictive
// golden at 2026-06-09T12:00Z. Only `dashas` and `snapshot` depend on the
// reference date, so the report fixture swaps in the engine's own `dashas` and
// `snapshot` for the same birth computed at the predictive instant. Regenerate
// (from backend/) with the chart-golden oracle:
//   compute_stamped_chart(datetime.fromisoformat(KEY), 28.6139, 77.2090,
//     reference_date=datetime(2026, 6, 9, 12, tzinfo=UTC)), canonicalized by
//   tests.test_chart_golden._canonicalize, keeping only dashas + snapshot.
const atInstant = natalAtPredictiveInstant as unknown as Pick<SiderealChart, "dashas" | "snapshot">;

/** The engine golden chart with its predictive contexts, as the app holds it. */
export const REPORT_RAW_CHART: SiderealChart = { ...natal, ...atInstant, ...predictive };
/** The predictive golden's own instant, which is also the dashas' reference date. */
export const REPORT_AS_OF: AnalysisInstant = { basis: "chart", instant: new Date("2026-06-09T12:00:00Z") };
export const REPORT_CHART: SanitizedChart = sanitizeChartForLlm(REPORT_RAW_CHART, REPORT_AS_OF);
