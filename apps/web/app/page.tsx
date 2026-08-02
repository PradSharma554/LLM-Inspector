import Link from "next/link";
import { fetchTraces, fetchStorageStats, type TraceRow } from "@/lib/api";
import {
  formatCost,
  formatMs,
  formatTokens,
  formatRelativeTime,
  formatBytes,
} from "@/lib/format";

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
          <span className="text-[var(--color-text-faint)]">
            {traces.length} trace{traces.length === 1 ? "" : "s"}
          </span>
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
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-[var(--color-panel)] z-10">
              <tr className="text-[var(--color-text-faint)] text-left">
                <Th className="w-6" />
                <Th>trace</Th>
                <Th className="w-24 text-right">duration</Th>
                <Th className="w-16 text-right">spans</Th>
                <Th className="w-20 text-right">tokens</Th>
                <Th className="w-24 text-right">cost</Th>
                <Th className="w-24 text-right">when</Th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-[var(--color-border-soft)] hover:bg-[var(--color-panel-2)] group"
                >
                  <Td>
                    <span
                      className={
                        t.status === "error"
                          ? "text-[var(--color-error)]"
                          : t.status === "in_progress"
                            ? "text-[var(--color-warn)]"
                            : "text-[var(--color-ok)]"
                      }
                      title={t.status}
                    >
                      {t.status === "error" ? "●" : t.status === "in_progress" ? "◐" : "○"}
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`/traces/${t.id}`}
                      className="hover:text-[var(--color-accent)] hover:underline"
                    >
                      {t.name}
                    </Link>
                    {t.error_count > 0 && (
                      <span className="ml-2 text-[var(--color-error)]">
                        {t.error_count} error{t.error_count === 1 ? "" : "s"}
                      </span>
                    )}
                    {t.dropped_spans > 0 && (
                      <span
                        className="ml-2 text-[var(--color-warn)]"
                        title="Spans dropped by the SDK buffer — surfaced so data loss is never silent"
                      >
                        {t.dropped_spans} dropped
                      </span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{formatMs(t.duration_ms)}</Td>
                  <Td className="text-right tabular-nums text-[var(--color-text-dim)]">
                    {t.span_count}
                  </Td>
                  <Td className="text-right tabular-nums text-[var(--color-text-dim)]">
                    {formatTokens(t.total_tokens)}
                  </Td>
                  <Td className="text-right tabular-nums">{formatCost(t.total_cost_usd)}</Td>
                  <Td className="text-right text-[var(--color-text-faint)]">
                    {formatRelativeTime(t.started_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-2 py-1 font-normal border-b border-[var(--color-border)] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1 ${className}`}>{children}</td>;
}
