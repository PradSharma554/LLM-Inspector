import { fetchTraces, fetchStorageStats, type TraceRow } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { TraceList } from "@/components/TraceList";

export const dynamic = "force-dynamic";

export default async function TraceListPage() {
  let traces: TraceRow[] = [];
  let stats = null;
  let error: string | null = null;

  try {
    [traces, stats] = await Promise.all([
      fetchTraces(100),
      fetchStorageStats().catch(() => null),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center justify-between px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-panel)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-accent)]">◆</span>
          <span className="font-semibold tracking-tight">LLM Execution Inspector</span>
        </div>
        {stats && stats.blobs > 0 && (
          <div
            className="text-[var(--color-text-faint)]"
            title="Content-addressed dedup + gzip on offloaded payloads"
          >
            payload storage {formatBytes(stats.logicalBytes)} → {formatBytes(stats.storedBytes)}
            <span className="text-[var(--color-ok)] ml-1.5">
              {stats.compressionRatio}× smaller
            </span>
          </div>
        )}
      </header>

      {error ? (
        <div className="p-4 text-[var(--color-error)]">
          <div className="mb-1">Could not reach the collector at the configured API base.</div>
          <div className="text-[var(--color-text-faint)]">{error}</div>
        </div>
      ) : traces.length === 0 ? (
        <div className="p-4 text-[var(--color-text-dim)]">
          <div className="mb-2">No traces yet.</div>
          <div className="text-[var(--color-text-faint)]">
            Send one with:{" "}
            <span className="text-[var(--color-text-dim)]">
              INSPECTOR_KEY=… node examples/agent-demo.mjs
            </span>
          </div>
        </div>
      ) : (
        // Server-rendered rows seed the client component, which then patches
        // them from the SSE feed. First paint needs no JavaScript.
        <TraceList initial={traces} />
      )}
    </div>
  );
}
