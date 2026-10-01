import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../..');
const EDGEPROC_BROWSER_SHA = '02171df60afc8b09d6439112ea7ea3202338d46a';
const readRoot = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const readSection = (document: string, heading: string): string => {
  const start = document.indexOf(heading);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  const end = document.indexOf('\n## ', start + heading.length);
  return document.slice(start, end < 0 ? undefined : end);
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (entry === '__tests__' || entry.includes('.test.') || entry.includes('.spec.')) return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry) ? [path] : [];
  });

describe('repository truth', () => {
  it('prints architecture paths that exist exactly as written', () => {
    const architecture = readSection(readRoot('README.md'), '## Architecture');
    const paths = [
      'frontend/apps/web',
      'frontend/packages/browser',
      'frontend/packages/store',
      'frontend/packages/llm',
      'frontend/packages/shared-types',
      'frontend/packages/constants',
      'frontend/packages/memory',
      'backend/src/almamesh',
    ];
    for (const path of paths) {
      expect(architecture).toContain(path);
      expect(existsSync(resolve(root, path))).toBe(true);
    }
  });

  it('describes PDF and network behavior without contradictions', () => {
    const readme = readRoot('README.md');
    expect(readme).toMatch(/the report is available without AI/i);
    // "Deterministic" used to be an unqualified adjective, and it was false:
    // two exports of one chart differed at 37 places. The README now has to say
    // what it means, so a reader can check it — and so can this test.
    expect(readme).toMatch(
      /export\s+the same chart twice and the two files are\s+byte-for-byte identical/,
    );
    expect(readme).toContain('| Birthplace search while online | Open-Meteo geocoding |');
    expect(readme).toContain('an offline city-list fallback is bundled');
    // Same lesson as the PDF line above, now applied to the CHART. "local and
    // deterministic" was an unqualified adjective and it was false: the engine
    // read the wall clock, so one birth record produced a different chart on a
    // different day. The README must now name the four inputs and say the
    // engine reads no clock, which is a claim a reader can actually check.
    expect(readme).toMatch(/chart computation stays on your device/);
    expect(readme).toContain('The engine reads no clock');
    expect(readme).toMatch(
      /pure function of four recorded\s+inputs — birth instant, latitude, longitude, and the \*reference instant\*/,
    );
    expect(readme).not.toContain('It stays disabled until a real interpretation has completed');
    expect(readme).not.toContain('birth location with zero network');
    expect(readme).not.toMatch(/exactly two (?:runtime )?(?:egresses|network|outbound)/i);
  });

  it('maps every shipped runtime egress surface to the README data-flow table', () => {
    const network = readSection(readRoot('README.md'), '## Runtime network and data flow');
    const evidence = [
      ['frontend/apps/web/src/lib/geo/onlineGeocoder.ts', 'geocoding-api.open-meteo.com', 'Open-Meteo'],
      ['frontend/packages/llm/src/client.ts', '/chat/completions', 'configured OpenAI-compatible endpoint'],
      ['frontend/packages/llm/src/client.ts', '/models', 'model list'],
      ['frontend/packages/llm/src/client.ts', '/credits', 'credit check'],
      ['frontend/apps/web/src/components/features/feedback/FeedbackWidget.tsx', 'challenges.cloudflare.com', 'Cloudflare Turnstile'],
      ['frontend/apps/web/src/lib/submitFeedback.ts', '/api/feedback', '/api/feedback'],
    ] as const;
    for (const [path, implementationNeedle, documentationNeedle] of evidence) {
      expect(readRoot(path), path).toContain(implementationNeedle);
      expect(network, documentationNeedle).toContain(documentationNeedle);
    }
    for (const privateBoundary of [
      'narrative you submit, as written',
      'optional message as written',
      'allowlisted codes only',
    ]) expect(network).toContain(privateBoundary);
  });

  it('routes production warnings and errors through the code-only diagnostic boundary', () => {
    const roots = [
      'frontend/apps/web/src',
      'frontend/apps/web/functions',
      'frontend/packages/browser/src',
      'frontend/packages/llm/src',
      'frontend/packages/memory/src',
      'frontend/packages/store/src',
    ].flatMap((path) => sourceFiles(resolve(root, path)));
    const violations = roots.filter((path) => {
      if (path.endsWith('/safeDiagnostics.ts')) return false;
      return /\bconsole\.(?:error|warn)\s*\(/.test(readFileSync(path, 'utf8'));
    });
    expect(violations.map((path) => path.replace(`${root}/`, ''))).toEqual([]);
  });

  it('publishes every production bundle with a signed monotonic sequence', () => {
    const build = readRoot('frontend/apps/web/scripts/build-prod.sh');
    expect(build).toContain('BUNDLE_SEQUENCE');
    expect(build).toContain('rev-list --count HEAD');
    expect(build).toContain('--sequence "${BUNDLE_SEQUENCE}"');
    expect(build).toContain('almamesh.edge.release_guard');
    expect(build).toContain('BUNDLE_LIVE_URL');
    const delivery = readRoot('dagger/src/index.ts');
    const proof = readRoot('dagger/src/deployment.ts');
    expect(delivery).toContain('export BUNDLE_LIVE_URL="${LIVE_ORIGIN}/bundle/latest"');
    expect(delivery).toContain('return releaseLiveVerificationScript(');
    expect(proof).toContain('Live app, bundle, and feedback route identity verified');
    expect(proof).toContain('expected_bundle=');
    expect(proof).toContain('AbortSignal.timeout(20_000)');
    expect(proof).not.toContain('curl');
    expect(`${delivery}\n${proof}`).not.toContain('wrangler pages deploy');
    expect(`${delivery}\n${proof}`).not.toContain('verify-pages-source.mjs');
  });

  it('re-signs the local dev bundle at a strictly increasing sequence (no self-inflicted rollback)', () => {
    // setup-dev-assets.sh regenerates the dev key and re-signs every run. A fixed
    // sequence would make an already-synced browser refuse the re-signed pointer
    // as a rollback against its durable OPFS floor. Epoch seconds only move forward.
    const setup = readRoot('frontend/apps/web/scripts/setup-dev-assets.sh');
    expect(setup).toContain('DEV_BUNDLE_SEQUENCE="${DEV_BUNDLE_SEQUENCE:-$(date +%s)}"');
    expect(setup).toContain('--version dev --sequence "${DEV_BUNDLE_SEQUENCE}" --offline');
  });

  it('requires the live-like WebKit engine and persistent fallback gate in CI', () => {
    const workflow = readRoot('dagger/src/index.ts');
    const gate = readRoot('frontend/apps/web/scripts/verify-webkit-engine.mjs');
    const frontendPackage = readRoot('frontend/package.json');

    expect(workflow).toContain('["chromium", "webkit"]');
    expect(workflow).toContain('"playwright", "install", "--with-deps", ...browsers');
    expect(frontendPackage).not.toContain('@edgeproc/browser test:coverage');
    expect(workflow).toContain(
      'node scripts/verify-webkit-engine.mjs http://127.0.0.1:4200',
    );
    expect(workflow).toContain(
      'node scripts/verify-webkit-engine.mjs http://127.0.0.1:4200 --first-session',
    );
    expect(workflow).toContain(
      './node_modules/.bin/vite preview --outDir dist-verify --host 127.0.0.1 --port 4200 --strictPort',
    );
    expect(workflow).not.toContain('python3 -m http.server 4200');
    expect(workflow).toContain(
      'node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4199 --browser=chromium',
    );
    expect(workflow).toContain(
      'node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4200 --browser=webkit',
    );
    expect(gate).toContain('webkit.launch({ headless: true })');
    expect(gate).toContain("u.includes('/bundle/latest')");
    expect(gate).toContain("'edgeproc-browser-cache'");
    expect(gate).toContain("'force-indexeddb-engine-cache'");
    expect(gate).toContain("storage.opfs === 'forced-unavailable'");
    expect(gate).toContain("storage.selectedCache === 'indexeddb'");
    expect(gate).toContain("context.route('**/bundle/**'");
    expect(gate).toContain("serviceWorkers: 'allow'");
    expect(gate).toContain('initialDocumentControlled: !uncontrolled');
    expect(gate).toContain('offlineDocumentControlled: controlled');
    expect(gate).toContain("proxy.state.rejected.includes('/public.key')");
    expect(gate).toContain('keyRequestsAfterRotation > keyRequestsBeforeRotation');
    expect(gate).toContain('blockedKeys.length >= 2');
    expect(gate).toContain('assertSingleSyncWorker');
    expect(gate).not.toContain("window.dispatchEvent(new Event('online'))");
    const provider = readRoot(
      'frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx',
    );
    expect(provider).toContain(
      "if (typeof window !== 'undefined' && EXIT_GATE_HOOKS)",
    );
    const worker = readRoot('frontend/packages/browser/src/edgeproc.worker.ts');
    expect(worker.trim()).toBe('import "@edgeproc/browser/worker";');
    const adapter = readRoot('frontend/packages/browser/src/edgeprocClient.ts');
    expect(adapter).toContain('database: "edgeproc-browser-cache"');
    expect(adapter).toContain('store: "content-addressed-cache"');
    expect(adapter).toContain('storageBackend: "indexeddb"');
    const chromium = readRoot('frontend/apps/web/scripts/verify-browser-parity.mjs');
    expect(chromium).toContain('exactly one consumer-owned edgeproc Worker asset');
  });

  it('pins the standalone browser Lego and removes the vendored workspace copy', () => {
    const browserPackage = JSON.parse(readRoot('frontend/packages/browser/package.json')) as {
      dependencies: Record<string, string>;
    };
    const memoryPackage = JSON.parse(readRoot('frontend/packages/memory/package.json')) as {
      dependencies: Record<string, string>;
    };
    const frontendPackage = JSON.parse(readRoot('frontend/package.json')) as {
      trustedDependencies?: string[];
    };
    expect(browserPackage.dependencies['@edgeproc/browser']).toBe(
      `github:hseshadr/edgeproc-browser#${EDGEPROC_BROWSER_SHA}`,
    );
    expect(memoryPackage.dependencies['@edgeproc/browser']).toBe(
      `github:hseshadr/edgeproc-browser#${EDGEPROC_BROWSER_SHA}`,
    );
    expect(frontendPackage.trustedDependencies ?? []).not.toContain('@edgeproc/browser');
    expect(readRoot('frontend/bun.lock')).toContain(EDGEPROC_BROWSER_SHA);
    expect(existsSync(resolve(root, 'frontend/packages/edgeproc-browser/package.json'))).toBe(false);
    expect(readRoot('frontend/apps/web/vite.config.ts')).not.toMatch(
      /vendored at packages\/edgeproc-browser|vendored packages\/edgeproc-browser/,
    );
    expect(readRoot('dagger/src/index.ts')).toContain(
      `const EDGEPROC_BROWSER_SHA = "${EDGEPROC_BROWSER_SHA}"`,
    );
  });

  it('keeps live semantic search entirely on SQLite + sqlite-vector in an OPFS Worker', () => {
    const store = readRoot('frontend/packages/memory/src/vectorStore.ts');
    const memoryIndex = readRoot('frontend/packages/memory/src/index.ts');
    const memoryPackage = readRoot('frontend/packages/memory/package.json');
    const appFactory = readRoot('frontend/apps/web/src/lib/chatMemory.ts');

    expect(store).toContain('createSqliteVectorIndex');
    expect(store).toContain('persistence: "opfs"');
    expect(store).toContain('.deleteWhere({ profile_id: profileId })');
    expect(store).toContain('.deleteWhere({ thread_id: threadId })');
    expect(store).not.toContain('new Map');
    expect(store).not.toContain('cosineSimilarity');
    expect(memoryIndex).not.toContain('./cosine');
    expect(memoryPackage).not.toContain('idb-keyval');
    expect(existsSync(resolve(root, 'frontend/packages/memory/src/cosine.ts'))).toBe(false);
    expect(appFactory).toContain('readDeletionTombstones');
    expect(appFactory).not.toContain('createGenerationAwareVectorStore();\n}');
    const browserProof = readRoot('frontend/apps/web/scripts/verify-sqlite-memory.mjs');
    expect(browserProof).toContain('window.__almameshVerifySqliteMemory()');
    expect(browserProof).toContain('twoWorkerLifecycles');
    expect(browserProof).toContain('oneEmittedWorkerAsset');
    expect(browserProof).toContain('zeroThirdPartyEgress');
    expect(browserProof).toContain('chromium, webkit');
    expect(readRoot('dagger/src/index.ts')).toContain(
      'node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4199 --browser=chromium',
    );
    expect(readRoot('dagger/src/index.ts')).toContain(
      'node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4200 --browser=webkit',
    );
  });

  it('proves destructive reset through durable storage and landing-page postconditions', () => {
    const proof = readRoot('frontend/apps/web/scripts/verify-privacy-reset.mjs');
    const dagger = readRoot('dagger/src/index.ts');
    expect(proof).toContain("localStorage.setItem('almamesh-chart', '1')");
    expect(proof).toContain("putIdbValue('almamesh-chart-library'");
    expect(proof).toContain("getByTestId('landing-nav-cta')");
    expect(proof).toContain("localStorage.getItem('almamesh-chart') === null");
    expect(proof).toContain("getIdbValue('almamesh-chart-library')");
    expect(proof).not.toContain('waitForURL');
    expect(proof).toContain('Reset postcondition failed');
    expect(dagger).toContain(
      'node scripts/verify-privacy-reset.mjs http://127.0.0.1:4199',
    );
    expect(dagger).not.toContain('http://privacy:4173');
  });

  it('keeps ordinary builds keyless while production and engine gates fail closed on trust assets', () => {
    const config = readRoot('frontend/apps/web/vite.config.ts');
    const testWorkflow = readRoot('dagger/src/index.ts');
    const productionBuild = readRoot('frontend/apps/web/scripts/build-prod.sh');

    expect(config).toContain('existsSync(TRUST_KEY_PATH)');
    expect(config).not.toContain('ALMAMESH_TRUST_KEY_PATH');
    expect(config).toContain("return { name: 'trust-key-config-unconfigured' }");
    expect(config).toMatch(/importScripts: \[\s*\.\.\.\(TRUST_KEY_CONFIG === null \? \[\] :/);
    expect(config).not.toContain('precache-isolation-heal');
    expect(config).toContain('manifest: keyPrecacheByResponseHeaders(entries, PRECACHE_HEADERS_KEY)');
    expect(config).toContain('precacheHeadersKeyedExtrasPlugin(),');

    const generateAssets = testWorkflow.indexOf('["bash", "apps/web/scripts/setup-dev-assets.sh"]');
    const buildExitGate = testWorkflow.indexOf('private builtBrowser(');
    expect(generateAssets).toBeGreaterThan(-1);
    expect(buildExitGate).toBeGreaterThan(generateAssets);

    const restoreProductionKey = testWorkflow.indexOf('withSecretVariable("BUNDLE_PRIVATE_KEY_B64"');
    const buildProduction = testWorkflow.indexOf('this.productionBuildScript()');
    expect(restoreProductionKey).toBeGreaterThan(-1);
    expect(buildProduction).toBeGreaterThan(restoreProductionKey);

    expect(productionBuild).toContain(
      'if [[ ! -f "${KEYS_DIR}/private.key" || ! -f "${KEYS_DIR}/public.key" ]]',
    );
    expect(productionBuild).toContain(
      'cp "${KEYS_DIR}/public.key" "${PUBLIC_DIR}/public.key"',
    );
    expect(productionBuild).toContain('for must in index.html sw.js manifest.webmanifest');
    expect(productionBuild).toContain('dist/public.key is not the production key');
    expect(productionBuild).toContain('engine-trust-config-${TRUST_KEY_HASH}.js');
    expect(productionBuild).toContain('__ALMAMESH_TRUST_KEY_B64__=\\"${TRUST_KEY_B64}\\"');
    expect(productionBuild).toContain(
      'importScripts(\\"${TRUST_KEY_CONFIG}\\",\\"engine-trust-install.js\\")',
    );
  });

  it('keeps the production private key outside the checkout and shreds it after deploy', () => {
    const build = readRoot('frontend/apps/web/scripts/build-prod.sh');
    const delivery = readRoot('dagger/src/index.ts');

    expect(build).toContain('PRODUCTION_KEYS_DIR');
    expect(build).toContain('bundle ./origin-prod "${KEYS_DIR}/private.key"');
    expect(build).toContain('--public-key "${KEYS_DIR}/public.key"');
    expect(build).toContain('cp "${KEYS_DIR}/public.key" "${PUBLIC_DIR}/public.key"');
    expect(delivery).toContain('.withMountedTemp(KEYS)');
    expect(delivery).toContain('export BUILD_COMMIT="$EXPECTED_SHA" PRODUCTION_KEYS_DIR="${KEYS}"');
    expect(delivery).not.toContain('mkdir -p keys-prod');
    expect(delivery).not.toContain('> keys-prod/private.key');
    expect(delivery).toContain('shred -f -n 3 -z --remove');
    expect(delivery).toContain('rm -rf "${KEYS}/"*');
    expect(delivery).toContain('.withoutSecretVariable("BUNDLE_PRIVATE_KEY_B64")');
  });

  it('records the complete PR 62 artifact and provenance behavior', () => {
    const unreleased = readSection(readRoot('CHANGELOG.md'), '## [Unreleased]');
    for (const claim of [
      'maha, antar, and pratyantar',
      'predictive cache identity',
      'interpretation provenance',
      'conservative life-event structuring',
      'semantic, geometric, and browser PDF gates',
    ]) expect(unreleased).toContain(claim);
  });

  it('dates the report baseline to v0.4.0 and all-table completion to PR 62', () => {
    const spec = readRoot('docs/specs/062-robust-rectifier-comprehensive-report.md');
    expect(spec).toContain(
      '**Status:** The v0.4.0 baseline is shipped; complete all-table report export is Unreleased in PR #62.',
    );
    expect(spec).not.toContain('**Status:** Shipped in v0.4.0');
  });

  it('uses the Vite 8 JSX config without deprecated transform keys', () => {
    const config = readRoot('frontend/apps/web/vitest.config.ts');
    expect(config).toContain('oxc:');
    expect(config).toContain('rolldownOptions:');
    expect(config).not.toContain("import react from '@vitejs/plugin-react'");
    expect(config).not.toContain('react()');
    expect(config).not.toContain('esbuild:');
    expect(config).not.toContain('esbuildOptions:');
  });

  it('publishes the categorized cleverness-debt ledger', () => {
    const path = 'docs/CLEVERNESS-DEBT.md';
    expect(existsSync(resolve(root, path))).toBe(true);
    const ledger = readRoot(path);
    for (const heading of [
      '## Remove now',
      '## Redesign only with a named consumer',
      '## Accepted boundary',
    ]) expect(ledger).toContain(heading);
    for (const boundary of [
      'Skyfield type edge',
      'PEP 562 lazy import',
      'Shadbala classical-argument shape',
      'JSON metadata',
      'Downstream raw Skyfield position mappings',
      'worker singletons',
      'lazy-load cache',
      'chat cache',
      'geocoder cache',
      'mutable store counters',
    ]) expect(ledger).toContain(boundary);
    for (const evidence of [
      'transits/positions.py',
      'transits/aspects.py',
      'transits/gochara.py',
      'Before adding another consumer of `get_planetary_positions()`',
    ]) expect(ledger).toContain(evidence);
  });

  it('records rigor stages 1-3 as shipped and Stage 4 as partial without overstating validity', () => {
    const rigor = readRoot('docs/rigor-upgrade-spec.md');
    for (const evidence of [
      '**Lifecycle:** PARTIAL',
      'Stages 1–3 shipped',
      'Stage 4 is PARTIAL',
      'assumptions panel and conservative web cusp proxy are shipped',
      'exact dual-lagna production wiring and PDF stability markers remain roadmap',
      'PR #56',
      'PR #58',
      'PR #57',
      'PR #59',
      'historical design and acceptance rationale',
      'not empirically validated life outcomes',
      'backend/tests/test_domain_strength_pct.py',
      'Exalted Jupiter in a kendra: net +2 / range −3..+3 → **83.33%**',
      'Debilitated Sun in a dusthana: net −2 / range −2..+2 → **0%**',
      'margin 0.42): **42%, consistent**',
      'Percentage and qualitative band are parallel explainable outputs',
      'Yoga grade remains `net ≥ 2` strong · `net ≤ −1` weak · otherwise moderate',
      'Domain band remains both signals strong → strong · both weak → weak · otherwise moderate',
      'Saturn-career 95% ∧ SAV 61% → **61%, strong**',
      'combust debilitated dusthana Mars',
      'non-combust debilitated dusthana Sun',
    ]) expect(rigor).toContain(evidence);
    for (const impossibleOrStaleClaim of [
      'Stages 1–4 shipped',
      'stages 1–4 complete',
      'Very strong — 92%',
      'net +4 of max +4',
      'Weak — 8%',
      'margin 0.42): **43%, consistent**',
      'margin-0.42 case → "43%, consistent"',
      '| %→band |',
      '≥75% strong · 40–75% moderate · <40% weak',
      '≥80% strong · 50–80% moderate · <50% weak',
      '**61%, moderate–strong**',
      'debil-combust-dusthana Sun',
    ]) expect(rigor).not.toContain(impossibleOrStaleClaim);
    for (const path of [
      'backend/tests/test_domain_strength_pct.py',
      'backend/tests/test_stability.py',
      'frontend/apps/web/src/components/features/report/__tests__/ReportAssumptions.test.tsx',
    ]) expect(existsSync(resolve(root, path))).toBe(true);

    const reportView = readRoot('frontend/apps/web/src/pages/ReportView.tsx');
    expect(reportView).toContain('reportStabilityMarkers(claimIds, nearCusp)');
    expect(reportView).not.toContain('diffMarkers(');

    const rectificationPdfTypes = readRoot(
      'frontend/apps/web/src/components/report-pdf/types.ts',
    );
    expect(rectificationPdfTypes).toContain('aggregate calibrated event-fit confidence percentage');
    expect(rectificationPdfTypes).toContain('Per-event evidence');
    expect(rectificationPdfTypes).not.toContain('QUALITATIVE ONLY by contract');
    expect(rectificationPdfTypes).not.toContain('never a percentage, margin number, or fit score');

    const yogaFactors = readRoot('backend/src/almamesh/yogas/factors.py');
    expect(yogaFactors).toContain('calibrated structural percentages');
    expect(yogaFactors).toContain('not empirically validated life outcomes');
    expect(yogaFactors).not.toContain('real factors, no percentages');

    const rectificationPdf = readRoot(
      'frontend/apps/web/src/components/report-pdf/sections/ReportPdfRectification.tsx',
    );
    expect(rectificationPdf).toContain('aggregate calibrated confidence percentage');
    expect(rectificationPdf).toContain('not a probability that the time is correct');
    expect(rectificationPdf).not.toContain('carries NO percentage');
  });

  it('allows only the gated aggregate rectification percentage across shipped truth surfaces', () => {
    const rectificationTruthSurfaces = [
      'docs/specs/059-event-based-rectification.md',
      'docs/specs/060-conversational-rectification-elicitation.md',
      'frontend/apps/web/src/components/features/report/__tests__/ReportRectification.test.tsx',
      'frontend/apps/web/src/pages/__tests__/ReportView.test.tsx',
      'frontend/apps/web/src/components/report-pdf/__tests__/comprehensiveSections.test.ts',
    ].map(readRoot).join('\n');
    for (const staleAbsolute of [
      'never a single percentage',
      'Never a headline %',
      '"no headline %" all continue to hold',
      'evidence and a margin — never a percentage',
      'No headline confidence %, ever',
      'no headline % appears anywhere',
      'ANTI-SCAM HARD LINE: no percentage',
      'NEVER a number or percentage',
      'no margin, no percentage anywhere in the slice',
    ]) expect(rectificationTruthSurfaces).not.toContain(staleAbsolute);
    expect(rectificationTruthSurfaces).toContain('calibrated aggregate percentage');
    expect(rectificationTruthSurfaces).toContain('provenance and its supporting ledger');
  });

  it.each([
    ['docs/specs/054-karma-action-classification.md', 'ROADMAP'],
    ['docs/specs/057-karma-gamification-ui.md', 'ROADMAP'],
    ['docs/specs/058-dasha-modifier-config.md', 'ROADMAP'],
    ['docs/specs/059-event-based-rectification.md', 'SHIPPED'],
    ['docs/specs/059-event-based-rectification-plan.md', 'SHIPPED'],
    ['docs/specs/060-conversational-rectification-elicitation.md', 'SHIPPED'],
    ['docs/specs/061-backup-restore-your-data.md', 'SHIPPED'],
    ['docs/specs/062-robust-rectifier-comprehensive-report.md', 'SHIPPED'],
    ['docs/specs/063-ai-tiers-ondevice-optin.md', 'SUPERSEDED'],
    ['docs/specs/064-seo-prerender-public-routes.md', 'SHIPPED'],
    ['docs/specs/SPEC-COMPLETION-TRACKING.md', 'SUPERSEDED'],
    ['docs/rigor-upgrade-spec.md', 'PARTIAL'],
  ])('%s has an explicit lifecycle', (path, lifecycle) => {
    const [title, separator, banner] = readRoot(path).split('\n');
    expect(title).toMatch(/^# /);
    expect(separator).toBe('');
    expect(banner).toBe(`**Lifecycle:** ${lifecycle}`);
  });
});
