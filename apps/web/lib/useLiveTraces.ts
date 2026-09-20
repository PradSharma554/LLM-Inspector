"use client";

import { useEffect, useRef, useState } from "react";
import type { TraceUpdatedEvent } from "@llm-inspector/protocol";
import { API_BASE, type TraceRow } from "./api";

export type LiveStatus = "connecting" | "live" | "unavailable";

/**
 * Subscribe to the collector's SSE feed and keep a trace list current.
 *
 * Seeded from the server-rendered rows, so the first paint is complete HTML
 * and this only ever patches it. That ordering matters: the page still works
 * with JavaScript disabled, behind a proxy that eats event streams, or when
 * the collector runs without Redis.
 */
export function useLiveTraces(initial: TraceRow[]) {
  const [traces, setTraces] = useState<TraceRow[]>(initial);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());

  // Latest event timestamp per trace, so an out-of-order delivery cannot
  // overwrite newer numbers with older ones. Pub/sub gives no ordering
  // guarantee, and a trace that flushes several batches produces several
  // events in quick succession.
  const seenAt = useRef<Map<string, string>>(new Map());

  // Server-rendered rows are the source of truth on navigation. Without this,
  // going back to the list would show whatever the previous mount accumulated.
  useEffect(() => {
    setTraces(initial);
  }, [initial]);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/v1/live`);

    source.onopen = () => setStatus("live");

    // EventSource retries on its own, so an error is only terminal when the
    // connection is closed for good — otherwise this is a transient blip and
    // reporting "unavailable" would flicker the badge on every reconnect.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setStatus("unavailable");
    };

    source.addEventListener("trace_updated", (e) => {
      let event: TraceUpdatedEvent;
      try {
        event = JSON.parse((e as MessageEvent).data);
      } catch {
        return;
      }

      const prev = seenAt.current.get(event.traceId);
      if (prev && prev > event.at) return;
      seenAt.current.set(event.traceId, event.at);

      setTraces((rows) => {
        const row: TraceRow = {
          id: event.traceId,
          project_id: event.projectId,
          name: event.name,
          started_at: event.startedAt,
          ended_at: null,
          duration_ms: event.durationMs,
          status: event.status,
          total_tokens: event.totalTokens,
          total_cost_usd: event.totalCostUsd === null ? "0" : String(event.totalCostUsd),
          span_count: event.spanCount,
          error_count: event.errorCount,
          // Not carried on the event: the bus sends the list columns only.
          // Keep whatever the server render had rather than inventing a zero.
          dropped_spans: rows.find((r) => r.id === event.traceId)?.dropped_spans ?? 0,
          metadata: rows.find((r) => r.id === event.traceId)?.metadata ?? {},
        };

        const i = rows.findIndex((r) => r.id === event.traceId);
        if (i === -1) return [row, ...rows];

        const next = [...rows];
        next[i] = row;
        return next;
      });

      // Flag the row as freshly updated so it can be highlighted briefly.
      setLiveIds((s) => new Set(s).add(event.traceId));
      setTimeout(() => {
        setLiveIds((s) => {
          const n = new Set(s);
          n.delete(event.traceId);
          return n;
        });
      }, 2000);
    });

    return () => source.close();
  }, []);

  return { traces, status, liveIds };
}
