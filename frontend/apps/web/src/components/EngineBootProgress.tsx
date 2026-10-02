import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { BootStage } from "@almamesh/browser";
import { useEngineBootProgress } from "../providers/chartEngineContext";

/** A bootstrap report rendered as an i18n key + params and an optional 0..1 fraction. */
interface EngineProgressLine {
  readonly key: string;
  readonly params: Record<string, string>;
  readonly fraction: number | null;
}

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/**
 * What the engine bootstrap is doing, from the latest report: the signed
 * bundle downloading (exact bytes from the signed manifest), a stalled
 * connection being retried, files being verified, or the Pyodide runtime
 * loading. Null when there is nothing byte-level to say.
 */
function describeEngineProgress(stage: BootStage | null): EngineProgressLine | null {
  if (stage === null) return null;
  if (stage.kind === "syncing") {
    const progress = stage.progress;
    if (progress === undefined) {
      return { key: "generating.engine_download_start", params: {}, fraction: null };
    }
    if (progress.phase === "chunks") {
      return {
        key: "generating.engine_download",
        params: { done: megabytes(progress.bytesDone), total: megabytes(progress.bytesTotal) },
        fraction: progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : null,
      };
    }
    if (progress.phase === "chunkRetry") {
      return { key: "generating.engine_retry", params: {}, fraction: null };
    }
    if (progress.phase === "verify") {
      return {
        key: "generating.engine_verify",
        params: {},
        fraction: progress.totalFiles > 0 ? progress.verifiedFiles / progress.totalFiles : null,
      };
    }
    return { key: "generating.engine_download_start", params: {}, fraction: null };
  }
  if (stage.kind === "booting-engine") {
    const received = stage.progress?.bytesReceived ?? 0;
    return received > 0
      ? { key: "generating.engine_runtime", params: { done: megabytes(received) }, fraction: null }
      : { key: "generating.engine_boot", params: {}, fraction: null };
  }
  return null;
}

/**
 * The generating screen's "what the engine is doing" line: a real number while
 * the engine downloads (bundle bytes, then the Pyodide runtime) — on a slow
 * link this takes minutes, and a bar that moves reads as slow, not stuck.
 *
 * Subscribes to the byte-level progress context ITSELF, so the page hosting it
 * (and every form field on that page) is not re-rendered per report.
 */
export function EngineBootProgress(): ReactElement | null {
  const { t } = useTranslation("onboarding");
  const line = describeEngineProgress(useEngineBootProgress());
  if (line === null) return null;
  return (
    <div className="mt-3" data-testid="engine-progress">
      {line.fraction !== null && (
        <div className="h-1.5 bg-background-tertiary rounded-full overflow-hidden mb-1">
          <div
            data-testid="engine-progress-bar"
            className="h-full bg-accent-gold/70 transition-all duration-300 ease-out"
            style={{ width: `${Math.round(line.fraction * 100)}%` }}
          />
        </div>
      )}
      <p className="text-text-muted text-xs">{t(line.key, line.params)}</p>
    </div>
  );
}
