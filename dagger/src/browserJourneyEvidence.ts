/** The one closed output tree exported by the browser-journeys CI job. */
export const BROWSER_JOURNEY_ARTIFACTS = "browser-journeys-artifacts"
export const BROWSER_JOURNEY_EVIDENCE = "browser-journeys-evidence"

export function validateBrowserJourneyExitCode(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("Browser journey exit status is invalid.")
  }
  return value
}

/** Run on the completed container snapshot, before returning any exportable directory. */
export function browserJourneyEvidenceScript(exitCode: number, commitSha: string): string {
  validateBrowserJourneyExitCode(exitCode)
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Browser journey commit is invalid.")
  const receipt = JSON.stringify({ schemaVersion: 1, commitSha, exitCode, scanned: true })
  return `set -euo pipefail
test -d ${BROWSER_JOURNEY_ARTIFACTS}
test ! -e ${BROWSER_JOURNEY_EVIDENCE}
cp -R ${BROWSER_JOURNEY_ARTIFACTS} ${BROWSER_JOURNEY_EVIDENCE}
printf '%s\\n' '${receipt}' > ${BROWSER_JOURNEY_EVIDENCE}/journey-status.json
bun scripts/artifactLeakScan.mjs ${BROWSER_JOURNEY_EVIDENCE}`
}

/** Host-side check AFTER export; any missing/corrupt receipt fails closed. */
export function browserJourneyStatusCheckScript(): string {
  return `const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync("browser-journeys-evidence/journey-status.json", "utf8"));
  const sha = process.env.EXPECTED_SHA;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "commitSha,exitCode,scanned,schemaVersion"
    || value.schemaVersion !== 1 || value.scanned !== true
    || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || value.commitSha !== sha
    || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) throw 0;
  console.log("Browser journey original exit status: " + value.exitCode);
  process.exit(value.exitCode);
} catch {
  console.error("Browser journey evidence receipt is missing or invalid.");
  process.exit(1);
}`
}
