// The single host-side check of the browser-journeys evidence receipt.
// Run from the repository root after `export --path=browser-journeys-evidence`
// with EXPECTED_SHA set. Exits with the journey's original status, or 1 when
// the receipt is missing, corrupt, or bound to another commit (fails closed).
import { readFileSync } from "node:fs";

try {
  const value = JSON.parse(readFileSync("browser-journeys-evidence/journey-status.json", "utf8"));
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
}
