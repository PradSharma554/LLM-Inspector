import type { SpanKind } from "@llm-inspector/protocol";

/**
 * Duration formatting that keeps columns aligned and stays readable.
 *
 * Sub-millisecond values matter in a waterfall (a prompt-assembly span can be
 * 200µs), so they are not rounded away to "0ms".
 */
export function formatNs(ns: number | null | undefined): string {
  if (ns === null || ns === undefined) return "—";
  const ms = ns / 1e6;
  if (ms < 1) return `${(ns / 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Cost formatting.
 *
 * `null` renders as "—", never "$0.00". An unknown-model cost is genuinely
 * unknown, and showing zero would silently understate a trace's real spend.
 */
export function formatCost(usd: number | string | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  const n = typeof usd === "string" ? Number(usd) : usd;
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** CSS custom-property colour per span kind, used by bars and legends alike. */
export const KIND_COLOR: Record<SpanKind, string> = {
  llm_call: "var(--color-kind-llm)",
  retrieval: "var(--color-kind-retrieval)",
  tool_call: "var(--color-kind-tool)",
  agent_step: "var(--color-kind-agent)",
  prompt_assembly: "var(--color-kind-prompt)",
  embedding: "var(--color-kind-embedding)",
  guardrail: "var(--color-kind-guardrail)",
  custom: "var(--color-text-faint)",
};

/** Compact labels — full kind names are too wide for a dense table. */
export const KIND_LABEL: Record<SpanKind, string> = {
  llm_call: "LLM",
  retrieval: "RETR",
  tool_call: "TOOL",
  agent_step: "AGENT",
  prompt_assembly: "PROMPT",
  embedding: "EMBED",
  guardrail: "GUARD",
  custom: "CUSTOM",
};
