import type { TokenUsage } from "./span.js";

/**
 * Per-million-token rates in USD.
 *
 * Cache multipliers, not absolute rates, because they are a property of the
 * caching mechanism rather than the model:
 *   - a cache READ  bills at ~0.10x the base input rate
 *   - a cache WRITE bills at  1.25x (5-minute TTL) or 2x (1-hour TTL)
 *
 * We assume the 5-minute TTL since it is the default. A workload using 1-hour
 * caching will under-report writes; `CACHE_WRITE_MULTIPLIER_1H` is exported so
 * a caller can opt into the other figure.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
export const CACHE_WRITE_MULTIPLIER_1H = 2.0;

/**
 * Rates as published for the first-party Anthropic API.
 *
 * Deliberately NOT exhaustive and deliberately NOT fetched at runtime: pricing
 * is a slow-moving business fact, and a hardcoded table that returns null for
 * unknown models is more honest than a stale cache pretending to be live.
 *
 * Bedrock and Vertex are partner-operated with separate pricing; a trace from
 * those providers will fall through to null rather than report a wrong number.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic — Claude 5 family
  "claude-fable-5": { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  "claude-mythos-5": { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // Anthropic — Claude 4 family
  "claude-opus-4-8": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-opus-4-7": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-opus-4-6": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-sonnet-4-6": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
});

/**
 * Compute cost for a span.
 *
 * Returns null for unknown models. This is the important behaviour: a confident
 * $0.00 on an unpriced model silently corrupts every aggregate above it, while
 * a null renders as "unknown" and stays honest. The UI shows unpriced spans
 * distinctly rather than folding them into the total as zero.
 */
export function computeCostUsd(
  model: string | undefined,
  usage: TokenUsage | null,
  opts: { cacheTtl?: "5m" | "1h" } = {},
): number | null {
  if (!model || !usage) return null;

  const rate = PRICING[normaliseModelId(model)];
  if (!rate) return null;

  const writeMultiplier =
    opts.cacheTtl === "1h" ? CACHE_WRITE_MULTIPLIER_1H : CACHE_WRITE_MULTIPLIER_5M;

  const perInputToken = rate.inputPerMTok / 1_000_000;
  const perOutputToken = rate.outputPerMTok / 1_000_000;

  // usage.inputTokens is the UNCACHED remainder; cache tokens bill separately
  // at their own multipliers. Summing them first and applying one rate — the
  // obvious shortcut — is precisely the bug this function exists to avoid.
  const cost =
    usage.inputTokens * perInputToken +
    usage.cacheReadTokens * perInputToken * CACHE_READ_MULTIPLIER +
    usage.cacheCreationTokens * perInputToken * writeMultiplier +
    usage.outputTokens * perOutputToken;

  return cost;
}

/**
 * Strip provider prefixes and date suffixes so Bedrock/Vertex-style ids match
 * the first-party table where the underlying model is the same.
 *
 * e.g. "anthropic.claude-opus-5" -> "claude-opus-5"
 *      "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
 */
export function normaliseModelId(model: string): string {
  let id = model.trim().toLowerCase();
  // Bedrock provider prefix
  id = id.replace(/^anthropic\./, "");
  // Vertex "@" version separator
  id = id.replace(/@\d{8}$/, "");
  // trailing date snapshot
  id = id.replace(/-\d{8}$/, "");
  return id;
}

/** Total prompt size, including cached portions. */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

/** Total tokens billed in either direction — what the UI shows as "tokens". */
export function totalTokens(usage: TokenUsage): number {
  return totalInputTokens(usage) + usage.outputTokens;
}
