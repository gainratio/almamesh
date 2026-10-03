import { type Page } from '@playwright/test';

/**
 * Shared helpers for the structured-interpretation e2e suites.
 *
 * These boot the REAL in-browser Pyodide engine (the same engine the exit-gate
 * harness proves charts generate in), generate a REAL Delhi sidereal chart
 * in-tab, and restore it through the real Backup & Restore UI so the canonical
 * OPFS SQLite store sees exactly the same production write path as a user
 * import. They are LLM-agnostic: the unit/contract suite
 * (interpretation.spec.ts) stubs the LLM via page.route, while the real
 * integration suite (interpretation.real.spec.ts) lets a real endpoint answer.
 *
 * Copied verbatim from the original interpretation.spec.ts so behavior is
 * identical across both suites.
 */

/** localStorage key holding the JSON-encoded LLM override settings. */
export const LLM_SETTINGS_KEY = 'almamesh-llm-settings';

// The known-good reference birth (matches scripts/verify-exit-gate.mjs):
// Delhi 1990-01-15 local 17:30 Asia/Kolkata == 1990-01-15T12:00:00Z.
// referenceDate pins the "current" dasha for determinism.
export const DELHI_BIRTH = {
  datetimeUtc: '1990-01-15T12:00:00.000Z',
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: '2025-01-01T00:00:00+00:00',
  name: 'Delhi Interp Test',
};

/**
 * A seedable birth for `seedChart`: the engine input (what
 * `window.__almameshGenerate` receives) plus the presentation fields the
 * stored chart carries verbatim (what ProfileSettings / the forms read).
 */
export interface SeedBirthSpec {
  /** Engine input. */
  name: string;
  datetimeUtc: string;
  latitude: number;
  longitude: number;
  referenceDate: string;
  /** Stored-chart presentation fields. */
  chartId: string;
  /** tz-naive local wall clock, `YYYY-MM-DDTHH:MM:SS` (form date/time init). */
  birthDatetimeLocal: string;
  timezone: string;
  city: string;
  locationName: string;
  state?: string;
  country?: string;
  /** e.g. 'approximate' — drives the birth-time-confidence UI when present. */
  timeConfidence?: string;
}

/** The default Delhi seed — byte-identical to what seedChart always stored. */
export const DELHI_SEED: SeedBirthSpec = {
  ...DELHI_BIRTH,
  chartId: 'interp-delhi-1990',
  birthDatetimeLocal: '1990-01-15T17:30:00',
  timezone: 'Asia/Kolkata',
  city: 'Delhi',
  locationName: 'Delhi, India',
};

/**
 * Wait for the engine to be `ready` with the `window.__almameshGenerate` hook
 * present (the VITE_EXIT_GATE_HOOKS gate). Call after any full document load —
 * a hard navigation re-boots the engine and resets the stage hook.
 */
export async function waitForEngineReady(page: Page) {
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __ALMAMESH_STAGE__?: string;
        __ALMAMESH_ERROR__?: string;
        __almameshGenerate?: unknown;
      };
      if (w.__ALMAMESH_ERROR__) throw new Error(`engine boot error: ${w.__ALMAMESH_ERROR__}`);
      return w.__ALMAMESH_STAGE__ === 'ready' && typeof w.__almameshGenerate === 'function';
    },
    { timeout: 120_000, polling: 500 },
  );
}

/**
 * Boot the in-browser engine and wait for it to be `ready` with the
 * `window.__almameshGenerate` hook present (the VITE_EXIT_GATE_HOOKS gate).
 * Mirrors CHECK 1 of scripts/verify-exit-gate.mjs.
 */
export async function bootEngine(page: Page) {
  // `/` is now the marketing splash, which intentionally defers the engine for a
  // fresh visitor (no saved chart). /onboarding is the first route that boots it
  // (mirrors CHECK 1 of scripts/verify-exit-gate.mjs).
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await waitForEngineReady(page);
}

/**
 * Generate a chart in-tab via the real engine (Delhi by default; pass `birth`
 * to seed any case, e.g. the rectification suite's Aquarius/Pisces-cusp birth),
 * then restore it through Settings → Data as a legacy JSON backup so the
 * dashboard reads it from canonical SQLite. This deliberately avoids writing
 * the retired IndexedDB source after the one-time migration has already run.
 * `yogaOverride`, when given, replaces the engine yogas in the stored
 * `yoga_ctx` (used to drive KeyFocusCard deterministically in the dedup test).
 *
 * The stored chart is REAL engine output — `sidereal_ctx` carries the actual
 * lagna + planets — because the app's stored-chart contract requires them
 * (`SiderealContext.planets` is non-optional and the dashboard reads it at
 * mount); a hand-stubbed chart without planets crashes to the ErrorBoundary.
 */
export async function seedChart(
  page: Page,
  opts: { yogaOverride?: unknown[]; birth?: SeedBirthSpec } = {},
) {
  const result = await page.evaluate(
    async (args) => {
      const { birth, yogaOverride } = args;
      interface EnginePeriod {
        lord: string;
        start_date: string;
        end_date: string;
        duration_years: number;
      }
      const w = window as unknown as {
        __almameshGenerate: (b: unknown) => Promise<{
          lagna: unknown;
          planets: unknown;
          yogas?: unknown[];
          ayanamsa_value?: number;
          dashas?: {
            current_maha?: EnginePeriod;
            current_antar?: EnginePeriod;
            current_pratyantar?: EnginePeriod;
            maha_dasha_sequence?: EnginePeriod[];
            convention?: string;
          };
        }>;
      };
      // Engine input is exactly the five fields the hook validates.
      const chart = await w.__almameshGenerate({
        datetimeUtc: birth.datetimeUtc,
        latitude: birth.latitude,
        longitude: birth.longitude,
        referenceDate: birth.referenceDate,
        name: birth.name,
      });

      const chartId = birth.chartId;
      const profileId = `${chartId}-profile`;
      const yogaCtx = yogaOverride ?? chart.yogas ?? [];
      const sidereal = yogaOverride
        ? { ...chart, yogas: yogaOverride }
        : chart;

      // The library stores the ADAPTER output (UI `VimshottariDashaData`), not
      // the raw engine dasha ctx — mirror @almamesh/store toDashaCtx
      // field-for-field, exactly like scripts/verify-wave-d.mjs, so the
      // IdentityStrip renders the full running daśā stack (never "Not
      // available").
      const dashaLeg = (p: EnginePeriod, level: 'maha' | 'antar' | 'pratyantar') => ({
        lord: p.lord,
        start_date: p.start_date,
        end_date: p.end_date,
        duration_years: p.duration_years,
        level,
      });
      const rawDashas = chart.dashas ?? {};
      const dashaCtx = rawDashas.current_maha
        ? {
            maha_dasha: dashaLeg(rawDashas.current_maha, 'maha'),
            ...(rawDashas.current_antar
              ? { antar_dasha: dashaLeg(rawDashas.current_antar, 'antar') }
              : {}),
            ...(rawDashas.current_pratyantar
              ? { pratyantar_dasha: dashaLeg(rawDashas.current_pratyantar, 'pratyantar') }
              : {}),
            full_sequence: (rawDashas.maha_dasha_sequence ?? []).map((p) => dashaLeg(p, 'maha')),
            ...(rawDashas.convention ? { convention: rawDashas.convention } : {}),
          }
        : undefined;

      const stored = {
        chart_id: chartId,
        profile_id: profileId,
        person_name: birth.name,
        is_primary: true,
        birth_data: {
          name: birth.name,
          birth_datetime_utc: birth.datetimeUtc,
          birth_datetime_local: birth.birthDatetimeLocal,
          ...(birth.timeConfidence ? { birth_time_confidence: birth.timeConfidence } : {}),
          birth_location_details: {
            city: birth.city,
            ...(birth.state ? { state: birth.state } : {}),
            ...(birth.country ? { country: birth.country } : {}),
            latitude: birth.latitude,
            longitude: birth.longitude,
            timezone: birth.timezone,
            location_name: birth.locationName,
          },
        },
        astronomical_calculations: {
          sidereal_ctx: {
            ayanamsa_value: chart.ayanamsa_value ?? 0,
            ayanamsa_type: 'lahiri',
            house_system: 'whole_sign',
            julian_day: 0,
            sidereal_time: 0,
            lagna: chart.lagna,
            planets: chart.planets,
          },
          varga_ctx: undefined,
          dasha_ctx: dashaCtx,
          yoga_ctx: yogaCtx,
          calculation_timestamp: '2025-01-01T00:00:00+00:00',
          software_version: 'almamesh-browser-engine',
        },
        interpretation: undefined,
        // The 2D kundli + 3D force-field hero render from the RAW SiderealChart.
        sidereal_chart: sidereal,
      };

      const backup = JSON.stringify({
        format: 'almamesh-backup',
        formatVersion: 1,
        app: { version: 'playwright-fixture' },
        exportedAt: '2025-01-01T00:00:00.000Z',
        encryption: 'none',
        stores: {
          'almamesh-profiles': {
            version: 1,
            state: {
              profiles: {
                [profileId]: {
                  id: profileId,
                  name: birth.name,
                  createdAt: '2025-01-01T00:00:00.000Z',
                  avatarTint: '#3A4FB0',
                  relationship: 'self',
                },
              },
              activeProfileId: profileId,
            },
          },
          'almamesh-chart-library': {
            version: 0,
            state: { charts: { [chartId]: stored } },
          },
        },
      });
      return {
        lagna: (chart.lagna as { sign?: string })?.sign ?? null,
        mahaLord: rawDashas.current_maha?.lord ?? null,
        antarLord: rawDashas.current_antar?.lord ?? null,
        backup,
      };
    },
    { birth: opts.birth ?? DELHI_SEED, yogaOverride: opts.yogaOverride ?? null },
  );

  // Exercise the shipped restore boundary instead of reaching around it with
  // a test-only persistence API. The fallback paths are still real browser UI:
  // an HTML file input for the chosen backup and a normal download for the
  // mandatory pre-import safety net.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker');
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await page.goto('/settings/data', { waitUntil: 'domcontentloaded' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('backup-import-button').click(),
  ]);
  await chooser.setFiles({
    name: `${opts.birth?.chartId ?? DELHI_SEED.chartId}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(result.backup, 'utf8'),
  });
  const confirm = page.getByTestId('backup-confirm-import');
  await confirm.waitFor({ state: 'visible' });
  await page
    .getByTestId('backup-safety-passphrase-input')
    .fill('almamesh-test-safety-passphrase');
  const [safetyDownload] = await Promise.all([
    page.waitForEvent('download'),
    confirm.click(),
  ]);
  await safetyDownload.cancel();
  await page.getByTestId('backup-safety-confirmation').waitFor({ state: 'visible' });
  await Promise.all([page.waitForEvent('domcontentloaded'), confirm.click()]);

  return {
    lagna: result.lagna,
    mahaLord: result.mahaLord,
    antarLord: result.antarLord,
  };
}
