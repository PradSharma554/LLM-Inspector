import type { Span } from "./span.js";

export interface SpanNode {
  span: Span;
  children: SpanNode[];
  /** Nesting depth, 0 for roots. Precomputed for flat virtualised rendering. */
  depth: number;
}

/**
 * Assemble a flat span list into the execution tree.
 *
 * Deliberately O(n) with two passes and no recursion on the input, so a
 * pathological trace (deep agent recursion, thousands of spans) cannot blow the
 * stack. This runs in both the API and the browser, which is the whole point of
 * it living in the protocol package.
 *
 * Orphans — spans whose parent is missing because its batch was dropped or is
 * still in flight — are promoted to roots rather than silently discarded. Losing
 * a parent should degrade the tree, not delete the child's data.
 */
export function buildSpanTree(spans: readonly Span[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) {
    nodes.set(span.id, { span, children: [], depth: 0 });
  }

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node); // true root, or orphan promoted
    }
  }

  // Sort siblings by start time so the waterfall reads chronologically, then
  // assign depth iteratively.
  const stack: SpanNode[] = [];
  for (const root of roots) stack.push(root);
  roots.sort(byStart);

  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort(byStart);
    for (const child of node.children) {
      child.depth = node.depth + 1;
      stack.push(child);
    }
  }

  return roots;
}

function byStart(a: SpanNode, b: SpanNode): number {
  return a.span.startNs - b.span.startNs;
}

/** Flatten a tree back to render order, respecting a collapsed-set. */
export function flattenTree(
  roots: readonly SpanNode[],
  collapsed: ReadonlySet<string> = new Set(),
): SpanNode[] {
  const out: SpanNode[] = [];
  // Reverse-push so pops come out in order.
  const stack: SpanNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (!collapsed.has(node.span.id)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
    }
  }
  return out;
}

/**
 * Self time: duration minus time accounted for by children.
 *
 * This is what makes a flame graph meaningful. A 4-second agent_step whose
 * children account for 3.9s spent almost nothing itself; one with 200ms of
 * children is doing something expensive in-process and is the real target.
 *
 * Overlapping children (parallel tool calls) are merged before subtracting, so
 * concurrent work is not double-counted into a negative self time.
 */
export function selfTimeNs(node: SpanNode): number | null {
  const { startNs, endNs } = node.span;
  if (endNs === null) return null;
  const total = endNs - startNs;
  if (node.children.length === 0) return total;

  const intervals = node.children
    .filter((c) => c.span.endNs !== null)
    .map((c) => [c.span.startNs, c.span.endNs!] as const)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let cursorStart = -1;
  let cursorEnd = -1;
  for (const [s, e] of intervals) {
    if (cursorEnd < s) {
      if (cursorEnd > cursorStart) covered += cursorEnd - cursorStart;
      cursorStart = s;
      cursorEnd = e;
    } else if (e > cursorEnd) {
      cursorEnd = e;
    }
  }
  if (cursorEnd > cursorStart) covered += cursorEnd - cursorStart;

  return Math.max(0, total - covered);
}
