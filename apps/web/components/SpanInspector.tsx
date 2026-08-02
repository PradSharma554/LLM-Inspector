"use client";

import { useEffect, useState } from "react";
import type { Span } from "@llm-inspector/protocol";
import { fetchPayloads } from "@/lib/api";
import { formatNs, formatCost, formatBytes, KIND_COLOR, KIND_LABEL } from "@/lib/format";

export function SpanInspector({ span, onClose }: { span: Span; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "payloads" | "raw">("overview");

  return (
    <aside className="w-[440px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-panel)] flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 h-7 border-b border-[var(--color-border)] shrink-0">
        <span
          className="px-1 text-[10px] rounded-[2px]"
          style={{ color: KIND_COLOR[span.kind], border: `1px solid ${KIND_COLOR[span.kind]}40` }}
        >
          {KIND_LABEL[span.kind]}
        </span>
        <span className="truncate flex-1" title={span.name}>
          {span.name}
        </span>
        <button
          onClick={onClose}
          className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      <div className="flex gap-3 px-3 h-6 border-b border-[var(--color-border)] shrink-0">
        <Tab active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </Tab>
        <Tab active={tab === "payloads"} onClick={() => setTab("payloads")}>
          Payloads
        </Tab>
        <Tab active={tab === "raw"} onClick={() => setTab("raw")}>
          Raw
        </Tab>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {tab === "overview" && <Overview span={span} />}
        {tab === "payloads" && <Payloads span={span} />}
        {tab === "raw" && (
          <pre className="whitespace-pre-wrap break-all text-[var(--color-text-dim)]">
            {JSON.stringify(span, null, 2)}
          </pre>
        )}
      </div>
    </aside>
  );
}

function Overview({ span }: { span: Span }) {
  const dur = (span.endNs ?? span.startNs) - span.startNs;
  const u = span.usage;

  return (
    <div className="space-y-4">
      {span.error && (
        <Section title="error">
          <div className="text-[var(--color-error)]">
            {span.error.type}
            {span.error.statusCode ? ` · HTTP ${span.error.statusCode}` : ""}
          </div>
          <div className="text-[var(--color-text-dim)] mt-0.5">{span.error.message}</div>
        </Section>
      )}

      <Section title="timing">
        <Field k="start" v={formatNs(span.startNs)} hint="offset from trace start" />
        <Field k="duration" v={formatNs(dur)} />
        {span.timing?.ttftNs != null && (
          <Field
            k="ttft"
            v={formatNs(span.timing.ttftNs)}
            hint="time to first token — only observable from the stream"
            accent
          />
        )}
        {span.timing?.chunkCount != null && (
          <Field k="chunks" v={String(span.timing.chunkCount)} />
        )}
        {span.timing?.ttftNs != null && dur > span.timing.ttftNs && (
          <Field
            k="streaming"
            v={formatNs(dur - span.timing.ttftNs)}
            hint="time spent emitting tokens after the first"
          />
        )}
      </Section>

      {u && (
        <Section title="tokens">
          {/*
            The cache split is shown separately rather than as one "input"
            number. Cache reads bill at ~0.1x and writes at 1.25-2x, so a
            single total cannot explain the cost figure below it.
          */}
          <Field k="input (uncached)" v={u.inputTokens.toLocaleString()} />
          {u.cacheReadTokens > 0 && (
            <Field
              k="cache read"
              v={u.cacheReadTokens.toLocaleString()}
              hint="billed at ~0.1× input rate"
              accent
            />
          )}
          {u.cacheCreationTokens > 0 && (
            <Field
              k="cache write"
              v={u.cacheCreationTokens.toLocaleString()}
              hint="billed at 1.25× (5m TTL)"
            />
          )}
          <Field k="output" v={u.outputTokens.toLocaleString()} />
          <Field
            k="cost"
            v={span.costUsd !== null ? formatCost(span.costUsd) : "unknown model"}
            accent={span.costUsd !== null}
          />
        </Section>
      )}

      {Object.keys(span.attributes).length > 0 && (
        <Section title="attributes">
          {Object.entries(span.attributes).map(([k, v]) => (
            <Field key={k} k={k} v={typeof v === "object" ? JSON.stringify(v) : String(v)} />
          ))}
        </Section>
      )}

      <Section title="identity">
        <Field k="span id" v={span.id} mono />
        <Field k="parent" v={span.parentSpanId ?? "— (root)"} mono />
        {span.attempt > 1 && <Field k="attempt" v={String(span.attempt)} accent />}
      </Section>
    </div>
  );
}

/**
 * Payload viewer.
 *
 * Fetched on click, never with the trace. Offloaded payloads live in object
 * storage and can be tens of KB each — pulling them for every span in a
 * waterfall would defeat the entire storage design.
 */
function Payloads({ span }: { span: Span }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPayloads(span.id)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [span.id]);

  const keys = Object.keys(span.payloads);
  if (keys.length === 0) {
    return <div className="text-[var(--color-text-faint)]">No payloads on this span.</div>;
  }
  if (loading) return <div className="text-[var(--color-text-faint)]">Loading…</div>;
  if (error) return <div className="text-[var(--color-error)]">{error}</div>;

  return (
    <div className="space-y-4">
      {keys.map((k) => {
        const meta = span.payloads[k]!;
        const body = data?.[k];
        return (
          <div key={k}>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-[var(--color-text)]">{k}</span>
              {meta.storage === "external" ? (
                <span
                  className="text-[var(--color-text-faint)]"
                  title={`content-addressed: ${meta.sha256.slice(0, 16)}…`}
                >
                  R2 · {formatBytes(meta.sizeBytes)}
                </span>
              ) : (
                <span className="text-[var(--color-text-faint)]">inline</span>
              )}
            </div>
            <pre className="whitespace-pre-wrap break-all bg-[var(--color-bg)] border border-[var(--color-border-soft)] p-2 max-h-72 overflow-auto text-[var(--color-text-dim)]">
              {typeof body === "string" ? body : JSON.stringify(body, null, 2)}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[var(--color-text-faint)] uppercase tracking-wide text-[10px] mb-1">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Field({
  k,
  v,
  hint,
  mono,
  accent,
}: {
  k: string;
  v: string;
  hint?: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex gap-2" title={hint}>
      <span className="text-[var(--color-text-faint)] w-[130px] shrink-0 truncate">{k}</span>
      <span
        className={`${accent ? "text-[var(--color-accent)]" : "text-[var(--color-text-dim)]"} ${
          mono ? "text-[10px]" : ""
        } break-all`}
      >
        {v}
      </span>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 -mb-px ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
      }`}
    >
      {children}
    </button>
  );
}
