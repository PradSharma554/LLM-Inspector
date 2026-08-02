import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchTrace } from "@/lib/api";
import { formatCost, formatMs, formatTokens } from "@/lib/format";
import { Waterfall } from "@/components/Waterfall";

export const dynamic = "force-dynamic";

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data;
  try {
    data = await fetchTrace(id);
  } catch {
    notFound();
  }

  const { trace, spans } = data;

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center gap-3 px-3 h-9 border-b border-[var(--color-border)] bg-[var(--color-panel)] shrink-0">
        <Link
          href="/"
          className="text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
        >
          ← traces
        </Link>
        <span className="text-[var(--color-border)]">|</span>
        <span className="font-semibold">{trace.name}</span>
        <span
          className={
            trace.status === "error" ? "text-[var(--color-error)]" : "text-[var(--color-ok)]"
          }
        >
          {trace.status}
        </span>

        <div className="flex-1" />

        <Stat label="duration" value={formatMs(trace.duration_ms)} />
        <Stat label="spans" value={String(trace.span_count)} />
        <Stat label="tokens" value={formatTokens(trace.total_tokens)} />
        <Stat label="cost" value={formatCost(trace.total_cost_usd)} />
        {trace.error_count > 0 && (
          <Stat label="errors" value={String(trace.error_count)} error />
        )}
      </header>

      <Waterfall spans={spans} />
    </div>
  );
}

function Stat({
  label,
  value,
  error,
}: {
  label: string;
  value: string;
  error?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[var(--color-text-faint)]">{label}</span>
      <span
        className={`tabular-nums ${error ? "text-[var(--color-error)]" : "text-[var(--color-text)]"}`}
      >
        {value}
      </span>
    </div>
  );
}
