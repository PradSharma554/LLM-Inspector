import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeCostUsd, normaliseModelId, totalTokens } from "./pricing.js";
import type { TokenUsage } from "./span.js";

const usage = (o: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  ...o,
});

describe("computeCostUsd", () => {
  test("prices uncached input and output at base rates", () => {
    // claude-opus-5: $5/MTok in, $25/MTok out
    const cost = computeCostUsd("claude-opus-5", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    assert.equal(cost, 30.0);
  });

  test("cache reads bill at 0.1x — the whole reason usage is split", () => {
    const cached = computeCostUsd("claude-opus-5", usage({ cacheReadTokens: 1_000_000 }));
    const uncached = computeCostUsd("claude-opus-5", usage({ inputTokens: 1_000_000 }));
    assert.equal(cached, 0.5);
    assert.equal(uncached, 5.0);
    // If someone "simplifies" by summing all input tokens first, these collapse.
    assert.notEqual(cached, uncached);
  });

  test("cache writes bill at 1.25x by default, 2x on 1h TTL", () => {
    const write5m = computeCostUsd("claude-opus-5", usage({ cacheCreationTokens: 1_000_000 }));
    const write1h = computeCostUsd("claude-opus-5", usage({ cacheCreationTokens: 1_000_000 }), {
      cacheTtl: "1h",
    });
    assert.equal(write5m, 6.25);
    assert.equal(write1h, 10.0);
  });

  test("returns null for unknown models rather than a confident zero", () => {
    // A wrong $0.00 silently corrupts every aggregate above it.
    assert.equal(computeCostUsd("some-unreleased-model", usage({ inputTokens: 1000 })), null);
    assert.equal(computeCostUsd(undefined, usage({ inputTokens: 1000 })), null);
    assert.equal(computeCostUsd("claude-opus-5", null), null);
  });

  test("a realistic cached RAG turn costs far less than naive math suggests", () => {
    // 50k cached system prompt + 2k fresh question + 500 out
    const real = computeCostUsd(
      "claude-opus-5",
      usage({ inputTokens: 2_000, cacheReadTokens: 50_000, outputTokens: 500 }),
    )!;
    // The bug this guards against: treating all 52k input tokens as uncached.
    const naive = computeCostUsd(
      "claude-opus-5",
      usage({ inputTokens: 52_000, outputTokens: 500 }),
    )!;
    assert.ok(real < naive, "cached turn must be cheaper");
    assert.ok(naive / real > 2, `naive math overstates cost by ${(naive / real).toFixed(1)}x`);
  });
});

describe("normaliseModelId", () => {
  test("strips bedrock prefix, vertex separator and date snapshots", () => {
    assert.equal(normaliseModelId("anthropic.claude-opus-5"), "claude-opus-5");
    assert.equal(normaliseModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(normaliseModelId("claude-opus-4-5@20251101"), "claude-opus-4-5");
    assert.equal(normaliseModelId("  Claude-Opus-5  "), "claude-opus-5");
  });
});

describe("totalTokens", () => {
  test("includes cached portions in the prompt total", () => {
    assert.equal(
      totalTokens(usage({ inputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 50, outputTokens: 20 })),
      1070,
    );
  });
});
