/**
 * The browser journeys, split into three lanes that run on three runners.
 *
 * One serial lane ran about 36 minutes on a normal runner and 48 on a slow one
 * (main runs 38845104492, 38922748755), and hit its cap once (46 minutes against
 * a 45-minute budget). Each step below carries the lane that runs it and its
 * measured wall time on a normal runner, in minutes, from those runs' logs. The
 * lanes come to about 10 to 11 minutes of tests each, so with the ~2 minute
 * build the longest lane is ~13 minutes normal, ~18 slow.
 *
 * Every step runs exactly once, in exactly one lane. tests/journey-lanes.test.ts
 * derives the partition from JOURNEY_STEPS, so adding a step without a lane, or
 * running one twice, fails there.
 */
export const JOURNEY_LANES = ["a", "b", "c"] as const

export type JourneyLane = (typeof JOURNEY_LANES)[number]

/** The product gate for each lane (see PRODUCT_GATES in gates.ts). */
export const JOURNEY_GATES = ["browserJourneysA", "browserJourneysB", "browserJourneysC"] as const

export interface JourneyStep {
  readonly lane: JourneyLane
  /** Measured minutes on a normal runner, used to balance the lanes. */
  readonly minutes: number
  readonly command: string
}

const URL = "http://127.0.0.1:4199"

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  // A brand-new browser restores a backup from the landing page (Chromium only).
  { lane: "a", minutes: 0.7, command: `FIRST_RUN_RESTORE_E2E_BASE_URL=${URL} bun run test:e2e:first-run-restore --project=chromium` },
  // The landing header fits 320/360/390/414 px phones in en/es/pt: no
  // sideways scroll, nav CTA fully on screen (Chromium device emulation).
  { lane: "c", minutes: 1.1, command: `LANDING_RESPONSIVE_E2E_BASE_URL=${URL} bun run test:e2e:landing-responsive` },
  { lane: "c", minutes: 0.5, command: `node scripts/verify-exit-gate.mjs ${URL}` },
  { lane: "c", minutes: 0.5, command: `node scripts/verify-i18n.mjs ${URL}` },
  { lane: "c", minutes: 0.5, command: `node scripts/verify-browser-parity.mjs ${URL} --reference-date=2025-01-01T00:00:00+00:00` },
  // Time handling through the real onboarding UI: DST gap/overlap prompts,
  // "unknown" computing at noon, and the Vedic weekday lord for Apia
  // (date-line) and Sydney (east of UTC) births. Chromium only.
  { lane: "c", minutes: 2.4, command: `TIME_HANDLING_E2E_BASE_URL=${URL} bun run test:e2e:time-handling --project=chromium` },
  // The onboarding AI step (Connect AI / Not now) and the chat's no-AI prompt
  // through real onboarding. Chromium here; WebKit and an iPhone run on macOS.
  { lane: "a", minutes: 0.3, command: `ONBOARDING_AI_E2E_BASE_URL=${URL} bun run test:e2e:onboarding-ai --project=chromium` },
  // Time travel (spec 2026-10-08), Inc A, B, C and D journeys: June 2019
  // typed in plain chat, an 18-month period, places, and the Time travel
  // button (2027 pinned; a Day pin found on the device). A stubbed
  // provider, the real engine. Chromium here; WebKit and an iPhone run on
  // macOS (.github/workflows/webkit-macos.yml), as Linux WebKit cannot boot the engine.
  // This single spec is distributed by test, one worker per sequential command,
  // and the two shards sit in different lanes.
  { lane: "a", minutes: 9.1, command: `TIME_TRAVEL_E2E_BASE_URL=${URL} bun run test:e2e:time-travel e2e/time-travel.spec.ts --project=chromium --fully-parallel --workers=1 --shard=1/2 --output=browser-journeys-artifacts/time-travel-shard-1` },
  { lane: "b", minutes: 6.9, command: `TIME_TRAVEL_E2E_BASE_URL=${URL} bun run test:e2e:time-travel e2e/time-travel.spec.ts --project=chromium --fully-parallel --workers=1 --shard=2/2 --output=browser-journeys-artifacts/time-travel-shard-2` },
  // Trip threads (2026-10-13): a new thread per trip with its place, trip-bound
  // tools, tool-call rows, the thread list, search and layout. Stubbed provider.
  { lane: "c", minutes: 5.2, command: `TIME_TRAVEL_E2E_BASE_URL=${URL} bun run test:e2e:time-travel e2e/time-travel-threads.spec.ts --project=chromium --workers=1 --output=browser-journeys-artifacts/time-travel-threads` },
  // A person added on /mesh survives an immediate full page load (the
  // write is on disk before the dialog moves on). Chromium only.
  { lane: "a", minutes: 0.1, command: `MESH_PERSIST_E2E_BASE_URL=${URL} bun run test:e2e:mesh-add-persist` },
  // A saved AI key and a finished chat turn survive an immediate full page
  // load (each save is on disk before the app says it is done). Chromium only.
  { lane: "a", minutes: 0.9, command: `DURABLE_SAVES_E2E_BASE_URL=${URL} bun run test:e2e:durable-saves` },
  // The exit-gate boot fault switch is in this hooks build (the frontend
  // gate proves the production build lacks it), and with it armed the
  // first boot's Worker throws a real WebAssembly RuntimeError: one
  // engine.boot_retry, a chart, no recovery card. Chromium here; the
  // WebKit project needs macOS OPFS.
  { lane: "b", minutes: 0.1, command: "node scripts/verify-boot-fault-hook.mjs dist-verify --present" },
  { lane: "b", minutes: 4.0, command: `BOOT_RETRY_E2E_BASE_URL=${URL} bun run test:e2e:boot-retry --project=chromium` },
]

/** The commands one lane runs, in the order the original single lane ran them. */
export function journeyCommands(lane: JourneyLane): string[] {
  return JOURNEY_STEPS.filter((step) => step.lane === lane).map((step) => step.command)
}

/** Validates caller input (a Dagger argument) into a known lane; anything else is refused. */
export function parseJourneyLane(value: string): JourneyLane {
  const lane = JOURNEY_LANES.find((known) => known === value)
  if (lane === undefined) throw new Error(`Browser journey lane is invalid; expected one of ${JOURNEY_LANES.join(", ")}.`)
  return lane
}

export function journeyLaneOfGate(gate: string): JourneyLane {
  const index = (JOURNEY_GATES as readonly string[]).indexOf(gate)
  if (index === -1) throw new Error(`"${gate}" is not a browser journey gate.`)
  return JOURNEY_LANES[index]
}

export function journeyGateOfLane(lane: JourneyLane): (typeof JOURNEY_GATES)[number] {
  return JOURNEY_GATES[JOURNEY_LANES.indexOf(lane)]
}
