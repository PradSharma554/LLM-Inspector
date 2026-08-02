"use client";

import { selfTimeNs, type SpanNode } from "@llm-inspector/protocol";
import { formatNs, KIND_COLOR } from "@/lib/format";

const ROW_H = 20;

/**
 * Flame graph — time on the x-axis, call depth on the y-axis.
 *
 * Complements the waterfall rather than duplicating it. The waterfall answers
 * "when did each thing happen"; the flame graph answers "where did the time
 * actually go", because a wide bar with narrow children is doing the work
 * itself, while a wide bar full of children is just waiting on them.
 */
export function FlameGraph({
  tree,
  totalNs,
  selectedId,
  onSelect,
}: {
  tree: SpanNode[];
  totalNs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const maxDepth = maxDepthOf(tree);

  return (
    <div className="flex-1 overflow-auto p-3">
      <div
        className="relative w-full"
        style={{ height: (maxDepth + 1) * ROW_H + 8, minWidth: 600 }}
      >
        {renderNodes(tree)}
      </div>

      <div className="mt-4 text-[var(--color-text-faint)]">
        Width is wall-clock duration. A wide bar whose children are narrow spent
        the time itself; one filled by its children was waiting on them.
      </div>
    </div>
  );

  function renderNodes(nodes: SpanNode[]): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    const stack = [...nodes];

    while (stack.length > 0) {
      const node = stack.pop()!;
      const s = node.span;
      const dur = (s.endNs ?? s.startNs) - s.startNs;
      const left = (s.startNs / totalNs) * 100;
      const width = Math.max(0.15, (dur / totalNs) * 100);
      const self = selfTimeNs(node);
      const isError = s.status === "error";

      out.push(
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={`absolute overflow-hidden cursor-pointer text-[10px] px-1 leading-[18px] ${
            selectedId === s.id ? "ring-1 ring-[var(--color-accent)]" : ""
          }`}
          style={{
            left: `${left}%`,
            width: `${width}%`,
            top: node.depth * ROW_H,
            height: ROW_H - 2,
            background: isError ? "var(--color-error)" : KIND_COLOR[s.kind],
            opacity: isError ? 0.75 : 0.45,
            color: "#0b0d10",
            fontWeight: 500,
          }}
          title={`${s.name}\ntotal ${formatNs(dur)} · self ${formatNs(self)}`}
        >
          {width > 4 ? s.name : ""}
        </div>,
      );

      for (const c of node.children) stack.push(c);
    }
    return out;
  }
}

function maxDepthOf(nodes: SpanNode[]): number {
  let max = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.depth > max) max = n.depth;
    for (const c of n.children) stack.push(c);
  }
  return max;
}
