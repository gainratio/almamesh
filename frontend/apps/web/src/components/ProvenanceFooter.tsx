import { useTranslation } from 'react-i18next'
import type { AstronomicalCalculations, ChartSnapshot } from '@almamesh/shared-types'
import { formatDisplayDate } from '../lib/dates'

/** "LAHIRI" -> "Lahiri", "TRUE_CHITRA" -> "True Chitra". */
function conventionLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(' ')
}

/** Strip a `.bsp`/`.all` extension so "de421.bsp" reads as "de421". */
function ephemerisLabel(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function asOf(instant: string): string {
  return formatDisplayDate(new Date(instant), { year: 'numeric', month: 'short', day: 'numeric' })
}

function stampedLine(snapshot: ChartSnapshot): string {
  return (
    `Calculated locally by AlmaMesh · Engine ${snapshot.engine_version} · Ayanamsa ` +
    `${conventionLabel(snapshot.ayanamsa)} · Ephemeris ${ephemerisLabel(snapshot.ephemeris_file)} · ` +
    `As of ${asOf(snapshot.reference_date)} · Snapshot ${snapshot.snapshot_id.slice(0, 12)}`
  )
}

/**
 * A stored snapshot is only trusted at the worker boundary; one restored from a
 * crafted or damaged backup may be any shape. Print it only when every field
 * the line reads is usable, else fall back to the legacy line.
 */
function isPrintableSnapshot(snapshot: unknown): snapshot is ChartSnapshot {
  if (snapshot === null || typeof snapshot !== 'object') return false
  const fields = snapshot as Record<string, unknown>
  const textFields = ['engine_version', 'ayanamsa', 'ephemeris_file', 'snapshot_id', 'reference_date']
  return (
    textFields.every((key) => typeof fields[key] === 'string') &&
    !Number.isNaN(Date.parse(fields.reference_date as string))
  )
}

function legacyLine(calculationTimestamp: string | undefined): string {
  const base =
    'Calculated locally by AlmaMesh · engine version not recorded (computed before charts ' +
    'carried a snapshot)'
  // The oldest backups recorded no instant at all: say nothing rather than "Invalid Date".
  if (calculationTimestamp === undefined || Number.isNaN(Date.parse(calculationTimestamp))) {
    return base
  }
  return `${base} · As of ${asOf(calculationTimestamp)}`
}

export interface ProvenanceFooterProps {
  /** The displayed chart's calculations; `null` while no chart is shown. */
  readonly calculations: Partial<
    Pick<AstronomicalCalculations, 'snapshot' | 'calculation_timestamp'>
  > | null
}

/**
 * Per-chart provenance line — trust through transparency.
 *
 * States how THIS chart was produced: the engine version, ayanamsa and
 * ephemeris recorded in its snapshot, as of its own analysis instant. Never the
 * running engine's metadata and never today's date: an old chart must not claim
 * a version it was not computed with. A chart stored before snapshots existed
 * says so instead of guessing.
 */
export function ProvenanceFooter({ calculations }: ProvenanceFooterProps) {
  const { t } = useTranslation()
  if (calculations === null) {
    return null
  }
  const { snapshot, calculation_timestamp: calculatedAt } = calculations
  return (
    <p
      className="mt-6 text-center text-xs text-text-secondary/70 select-text"
      aria-label={t('provenance.aria')}
      data-testid="provenance-footer"
    >
      {isPrintableSnapshot(snapshot) ? stampedLine(snapshot) : legacyLine(calculatedAt)}
    </p>
  )
}
