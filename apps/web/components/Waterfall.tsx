"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  buildSpanTree,
  flattenTree,
  selfTimeNs,
  type Span,
  type SpanNode,
} from "@llm-inspector/protocol";
import { formatNs, formatCost, formatTokens, KIND_COLOR, KIND_LABEL } from "@/lib/format";
import { SpanInspector } from "./SpanInspector";
import { FlameGraph } from "./FlameGraph";

const ROW_HEIGHT = 22;
/** Render a window of rows plus this much padding, so scrolling never blanks. */
const OVERSCAN = 12;

export function Waterfall({ spans }: { spans: Span[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"waterfall" | "flame">("waterfall");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Tree assembly is the SAME function the API uses — one implementation,
  // tested once in the protocol package rather than reimplemented per surface.
  const tree = useMemo(() => buildSpanTree(spans), [spans]);
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  /**
   * Total span of the trace, used to scale every bar.
   *
   * Derived from max(endNs) rather than the root's duration: an orphaned span
   * whose parent was dropped can extend past the root, and clipping it would
   * hide real work.
   */
  const totalNs = useMemo(
    () => Math.max(1, ...spans.map((s) => s.endNs ?? s.startNs)),
    [spans],
  );

  const selected = useMemo(
    () => spans.find((s) => s.id === selectedId) ?? null,
    [spans, selectedId],
  );

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Keyboard navigation — DevTools users expect j/k and arrow keys, and it
  // costs almost nothing to support.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const idx = rows.findIndex((r) => r.span.id === selectedId);

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = rows[Math.min(rows.length - 1, idx + 1)];
        if (next) setSelectedId(next.span.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = rows[Math.max(0, idx - 1)];
        if (prev) setSelectedId(prev.span.id);
      } else if (e.key === "ArrowLeft" && selectedId) {
        e.preventDefault();
        setCollapsed((p) => new Set(p).add(selectedId));
      } else if (e.key === "ArrowRight" && selectedId) {
        e.preventDefault();
        setCollapsed((p) => {
          const n = new Set(p);
          n.delete(selectedId);
          return n;
        });
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Virtualisation: a long agent trace can be thousands of spans, and naive
  // rendering janks badly. Only the visible window is mounted.
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-3 px-3 h-7 border-b border-[var(--color-border)] bg-[var(--color-panel)] shrink-0">
          <Tab active={view === "waterfall"} onClick={() => setView("waterfall")}>
            Waterfall
          </Tab>
          <Tab active={view === "flame"} onClick={() => setView("flame")}>
            Flame
          </Tab>
          <div className="flex-1" />
          <span className="text-[var(--color-text-faint)]">
            {rows.length} rows · j/k to move · ←/→ to fold
          </span>
        </div>

        {view === "flame" ? (
          <FlameGraph
            tree={tree}
            totalNs={totalNs}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <>
            <div className="flex items-center h-6 px-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-faint)] shrink-0">
              <div className="w-[300px] shrink-0">span</div>
              <div className="w-14 text-right shrink-0">self</div>
              <div className="w-16 text-right shrink-0">total</div>
              <div className="w-14 text-right shrink-0">ttft</div>
              <div className="w-16 text-right shrink-0">tokens</div>
              <div className="w-20 text-right shrink-0 pr-3">cost</div>
              <div className="flex-1 min-w-[120px]">timeline</div>
            </div>

            <div
              ref={scrollRef}
              className="flex-1 overflow-auto"
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            >
              <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
                <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
                  {visible.map((node) => (
                    <Row
                      key={node.span.id}
                      node={node}
                      totalNs={totalNs}
                      selected={node.span.id === selectedId}
                      collapsed={collapsed.has(node.span.id)}
                      onSelect={() => setSelectedId(node.span.id)}
                      onToggle={() => toggle(node.span.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {selected && (
        <SpanInspector span={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function Row({
  node,
  totalNs,
  selected,
  collapsed,
  onSelect,
  onToggle,
}: {
  node: SpanNode;
  totalNs: number;
  selected: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const s = node.span;
  const dur = (s.endNs ?? s.startNs) - s.startNs;
  const left = (s.startNs / totalNs) * 100;
  const width = Math.max(0.25, (dur / totalNs) * 100);
  const self = selfTimeNs(node);
  const hasChildren = node.children.length > 0;
  const isError = s.status === "error";
  const tokens = s.usage
    ? s.usage.inputTokens +
      s.usage.outputTokens +
      s.usage.cacheReadTokens +
      s.usage.cacheCreationTokens
    : null;

  // TTFT rendered as a marker inside the bar: the gap before it is waiting,
  // the rest is streaming. That split is the most useful thing a developer can
  // see about an LLM call.
  const ttftPct =
    s.timing?.ttftNs != null && dur > 0 ? Math.min(100, (s.timing.ttftNs / dur) * 100) : null;

  return (
    <div
      onClick={onSelect}
      style={{ height: ROW_HEIGHT }}
      className={`flex items-center px-2 cursor-pointer border-b border-[var(--color-border-soft)] ${
        selected ? "bg-[var(--color-panel-2)]" : "hover:bg-[var(--color-panel)]"
      }`}
    >
      <div className="w-[300px] shrink-0 flex items-center gap-1 overflow-hidden">
        <span style={{ width: node.depth * 12 }} className="shrink-0" />
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="w-3 shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className="shrink-0 px-1 text-[10px] rounded-[2px]"
          style={{ color: KIND_COLOR[s.kind], border: `1px solid ${KIND_COLOR[s.kind]}40` }}
        >
          {KIND_LABEL[s.kind]}
        </span>
        <span
          className={`truncate ${isError ? "text-[var(--color-error)]" : ""}`}
          title={s.name}
        >
          {s.name}
        </span>
        {s.attempt > 1 && (
          <span
            className="shrink-0 text-[var(--color-warn)]"
            title={`Retry attempt ${s.attempt} — retries are first-class spans`}
          >
            ↻{s.attempt}
          </span>
        )}
      </div>

      <div className="w-14 text-right shrink-0 tabular-nums text-[var(--color-text-faint)]">
        {formatNs(self)}
      </div>
      <div className="w-16 text-right shrink-0 tabular-nums text-[var(--color-text-dim)]">
        {formatNs(dur)}
      </div>
      <div className="w-14 text-right shrink-0 tabular-nums text-[var(--color-kind-llm)]">
        {s.timing?.ttftNs != null ? formatNs(s.timing.ttftNs) : ""}
      </div>
      <div className="w-16 text-right shrink-0 tabular-nums text-[var(--color-text-faint)]">
        {formatTokens(tokens)}
      </div>
      <div className="w-20 text-right shrink-0 tabular-nums pr-3">
        {s.costUsd !== null ? formatCost(s.costUsd) : ""}
      </div>

      <div className="flex-1 min-w-[120px] relative h-full">
        <div
          className="absolute top-1/2 -translate-y-1/2 h-[9px] rounded-[1px]"
          style={{
            left: `${left}%`,
            width: `${width}%`,
            background: isError ? "var(--color-error)" : KIND_COLOR[s.kind],
            opacity: isError ? 0.8 : 0.55,
          }}
          title={`${formatNs(dur)}${s.timing?.ttftNs != null ? ` · ttft ${formatNs(s.timing.ttftNs)}` : ""}`}
        >
          {ttftPct !== null && (
            <div
              className="absolute top-0 bottom-0 w-[2px] bg-white/85"
              style={{ left: `${ttftPct}%` }}
              title={`time to first token: ${formatNs(s.timing!.ttftNs!)}`}
            />
          )}
        </div>
      </div>
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
      className={`px-1 border-b-2 -mb-px ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
      }`}
    >
      {children}
    </button>
  );
}
