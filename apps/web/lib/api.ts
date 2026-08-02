import type { Span } from "@llm-inspector/protocol";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

export interface TraceRow {
  id: string;
  project_id: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: "ok" | "error" | "cancelled" | "in_progress";
  total_tokens: number;
  total_cost_usd: string;
  span_count: number;
  error_count: number;
  dropped_spans: number;
  metadata: Record<string, unknown>;
}

export interface TraceDetail {
  trace: TraceRow;
  spans: Span[];
}

export async function fetchTraces(limit = 50): Promise<TraceRow[]> {
  const res = await fetch(`${API_BASE}/v1/traces?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load traces: ${res.status}`);
  return (await res.json()).traces;
}

export async function fetchTrace(id: string): Promise<TraceDetail> {
  const res = await fetch(`${API_BASE}/v1/traces/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load trace: ${res.status}`);
  const data = await res.json();
  return { trace: data.trace, spans: data.spans };
}

/**
 * Fetch a span's payloads on demand.
 *
 * Separate from the trace fetch on purpose: the waterfall renders from
 * metadata alone, so prompt and completion bytes are only pulled when a user
 * actually clicks into a span. That is the whole reason payloads are offloaded
 * to object storage rather than living in the span row.
 */
export async function fetchPayloads(spanId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/v1/spans/${spanId}/payload`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load payload: ${res.status}`);
  return (await res.json()).payloads;
}

export interface StorageStats {
  blobs: number;
  totalReferences: number;
  logicalBytes: number;
  storedBytes: number;
  compressionRatio: number | null;
  bytesSaved: number;
}

export async function fetchStorageStats(): Promise<StorageStats> {
  const res = await fetch(`${API_BASE}/v1/stats/storage`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load stats: ${res.status}`);
  return res.json();
}
