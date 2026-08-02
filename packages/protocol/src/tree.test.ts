import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSpanTree, flattenTree, selfTimeNs } from "./tree.js";
import type { Span } from "./span.js";

let counter = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const span = (o: Partial<Span> & { id: string }): Span =>
  ({
    traceId: uuid(999),
    parentSpanId: null,
    kind: "custom",
    name: `span-${counter++}`,
    startNs: 0,
    endNs: 1000,
    status: "ok",
    error: null,
    attempt: 1,
    usage: null,
    timing: null,
    costUsd: null,
    attributes: {},
    payloads: {},
    ...o,
  }) as Span;

describe("buildSpanTree", () => {
  test("nests children and assigns depth", () => {
    const roots = buildSpanTree([
      span({ id: uuid(1) }),
      span({ id: uuid(2), parentSpanId: uuid(1) }),
      span({ id: uuid(3), parentSpanId: uuid(2) }),
    ]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.depth, 0);
    assert.equal(roots[0]!.children[0]!.depth, 1);
    assert.equal(roots[0]!.children[0]!.children[0]!.depth, 2);
  });

  test("sorts siblings chronologically regardless of input order", () => {
    const roots = buildSpanTree([
      span({ id: uuid(1) }),
      span({ id: uuid(3), parentSpanId: uuid(1), startNs: 500 }),
      span({ id: uuid(2), parentSpanId: uuid(1), startNs: 100 }),
    ]);
    const order = roots[0]!.children.map((c) => c.span.startNs);
    assert.deepEqual(order, [100, 500]);
  });

  test("promotes orphans to roots instead of dropping them", () => {
    // Parent's batch was dropped or is still in flight — the child's data
    // must still be visible.
    const roots = buildSpanTree([span({ id: uuid(2), parentSpanId: uuid(404) })]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.span.id, uuid(2));
  });

  test("handles a deep chain without stack overflow", () => {
    const spans: Span[] = [span({ id: uuid(0) })];
    for (let i = 1; i < 5000; i++) {
      spans.push(span({ id: uuid(i), parentSpanId: uuid(i - 1) }));
    }
    const roots = buildSpanTree(spans);
    assert.equal(roots.length, 1);
    assert.equal(flattenTree(roots).length, 5000);
  });
});

describe("flattenTree", () => {
  test("returns render order and respects collapsed nodes", () => {
    const roots = buildSpanTree([
      span({ id: uuid(1) }),
      span({ id: uuid(2), parentSpanId: uuid(1), startNs: 10 }),
      span({ id: uuid(3), parentSpanId: uuid(1), startNs: 20 }),
    ]);
    assert.equal(flattenTree(roots).length, 3);
    assert.equal(flattenTree(roots, new Set([uuid(1)])).length, 1);
  });
});

describe("selfTimeNs", () => {
  test("subtracts child time from parent duration", () => {
    const roots = buildSpanTree([
      span({ id: uuid(1), startNs: 0, endNs: 1000 }),
      span({ id: uuid(2), parentSpanId: uuid(1), startNs: 100, endNs: 700 }),
    ]);
    assert.equal(selfTimeNs(roots[0]!), 400);
  });

  test("merges overlapping children so parallel work is not double-counted", () => {
    // Two tool calls running concurrently, 0-600 and 300-900.
    // Naive subtraction gives 1000 - 600 - 600 = -200. Correct is 1000-900=100.
    const roots = buildSpanTree([
      span({ id: uuid(1), startNs: 0, endNs: 1000 }),
      span({ id: uuid(2), parentSpanId: uuid(1), startNs: 0, endNs: 600 }),
      span({ id: uuid(3), parentSpanId: uuid(1), startNs: 300, endNs: 900 }),
    ]);
    assert.equal(selfTimeNs(roots[0]!), 100);
  });

  test("returns null for an unfinished span", () => {
    const roots = buildSpanTree([span({ id: uuid(1), endNs: null })]);
    assert.equal(selfTimeNs(roots[0]!), null);
  });
});
