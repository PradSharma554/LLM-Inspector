"use client";

import Link from "next/link";
import type { TraceRow } from "@/lib/api";
import { useLiveTraces } from "@/lib/useLiveTraces";
import { formatCost, formatMs, formatTokens, formatRelativeTime } from "@/lib/format";

/**
 * The trace table, kept current over SSE.
 *
 * Seeded with server-rendered rows and patched from the live feed, so the
 * first paint needs no JavaScript and the feed is purely additive.
 */
export function TraceList({ initial }: { initial: TraceRow[] }) {
  const { traces, status, liveIds } = useLiveTraces(initial);

  return (
    <>
      <div className="flex items-center gap-2 px-3 h-6 border-b border-[var(--color-border-soft)] bg-[var(--color-panel)] shrink-0 text-[var(--color-text-faint)]">
        <span className="text-[var(--color-text-dim)]">
          {traces.length} trace{traces.length === 1 ? "" : "s"}
        </span>
        <LiveBadge status={status} />
      </div>

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
                className={`border-b border-[var(--color-border-soft)] hover:bg-[var(--color-panel-2)] group ${
                  liveIds.has(t.id) ? "bg-[var(--color-panel-2)]" : ""
                }`}
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
    </>
  );
}

/**
 * Connection state, shown rather than hidden.
 *
 * "unavailable" is a real production state — the collector runs without Redis
 * today — and a live view that has silently stopped updating is worse than one
 * that says so.
 */
function LiveBadge({ status }: { status: "connecting" | "live" | "unavailable" }) {
  if (status === "live") {
    return (
      <span className="text-[var(--color-ok)]" title="Streaming updates over SSE">
        ● live
      </span>
    );
  }
  if (status === "connecting") {
    return <span className="text-[var(--color-text-faint)]">◌ connecting</span>;
  }
  return (
    <span
      className="text-[var(--color-text-faint)]"
      title="The collector has no Redis configured, so the feed is unavailable. Reload to refresh."
    >
      ○ not live
    </span>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-2 py-1 font-normal border-b border-[var(--color-border)] ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1 ${className}`}>{children}</td>;
}
