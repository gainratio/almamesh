export type ProcessKind = 'renderer' | 'gpu' | 'utility' | 'zygote' | 'browser' | 'webkit-web' | 'webkit-network' | 'other'

export interface ProcessEntry {
  readonly pid: number
  readonly kind: ProcessKind
  readonly rssBytes: number
}

export interface ProcessTreeSummary {
  readonly totalMiB: number
  readonly byKind: Partial<Record<ProcessKind, number>>
  readonly processes: number
}

export interface ProcessTreePeak extends ProcessTreeSummary {
  readonly samples: number
}

export function parseProcStat(text: string): { pid: number; ppid: number }
export function parseVmRssBytes(statusText: string): number | null
export function processKind(argv: readonly string[]): ProcessKind
export function descendantPids(rootPid: number, parents: ReadonlyMap<number, number>): number[]
export function readProcessTree(rootPid?: number, procRoot?: string): ProcessEntry[] | null
export function summarizeProcessTree(entries: readonly ProcessEntry[]): ProcessTreeSummary
export function sampleProcessTreePeak(
  intervalMs?: number,
  rootPid?: number,
  procRoot?: string,
): { stop: () => Promise<ProcessTreePeak | null> }

export type MemoryReportValue = number | string | null

export function formatMemoryReport(lane: string, fields: Readonly<Record<string, MemoryReportValue>>): string
export function processTreeReport(
  peak: ProcessTreePeak | null,
  kinds: readonly ProcessKind[],
): Record<string, MemoryReportValue>
