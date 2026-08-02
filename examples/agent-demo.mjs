/**
 * End-to-end demo: a RAG + tool-calling agent, instrumented with the SDK.
 *
 * Uses a fake Anthropic client so the demo runs with no API key and no cost,
 * but emits the real streaming event shapes — message_start with the cache
 * breakdown, content_block_delta for tokens, message_delta for output usage.
 * The instrumentation path exercised here is exactly the production one.
 *
 *   node examples/agent-demo.mjs
 */
import { Inspector } from "../packages/sdk/dist/index.js";

const ENDPOINT = process.env.INSPECTOR_ENDPOINT ?? "http://localhost:4000";
const API_KEY = process.env.INSPECTOR_KEY;
if (!API_KEY) {
  console.error("Set INSPECTOR_KEY to your project's ingest key.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake provider emitting real Anthropic stream event shapes. */
class FakeAnthropic {
  constructor() {
    this.callCount = 0;
    this.messages = {
      create: async (params) => {
        this.callCount++;
        await sleep(120 + Math.random() * 180);
        // First call fails once, to exercise retry spans.
        if (params.__flaky && this.callCount === 1) {
          throw Object.assign(new Error("Overloaded"), { status: 529 });
        }
        return {
          model: params.model,
          content: [{ type: "text", text: "The Q3 total was $1.2M." }],
          usage: {
            input_tokens: 340,
            output_tokens: 96,
            cache_read_input_tokens: params.__cached ? 48_000 : 0,
            cache_creation_input_tokens: params.__cached ? 0 : 12_000,
          },
        };
      },
      stream: (params) => {
        const model = params.model;
        async function* gen() {
          await sleep(280); // realistic time-to-first-token
          yield {
            type: "message_start",
            message: {
              model,
              usage: {
                input_tokens: 1_240,
                cache_read_input_tokens: 52_400,
                cache_creation_input_tokens: 0,
                output_tokens: 0,
              },
            },
          };
          const words = "Based on the retrieved documents, Q3 revenue reached 1.2 million dollars, up 18 percent year over year.".split(" ");
          for (const w of words) {
            await sleep(12);
            yield { type: "content_block_delta", delta: { type: "text_delta", text: w + " " } };
          }
          yield {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: words.length },
          };
        }
        const it = gen();
        return {
          [Symbol.asyncIterator]: () => it,
          finalMessage: async () => ({ model, usage: { input_tokens: 1_240, output_tokens: 22 } }),
        };
      },
    };
  }
}

const inspector = new Inspector({
  endpoint: ENDPOINT,
  apiKey: API_KEY,
  flushIntervalMs: 1000,
  onError: (e) => console.error("[inspector]", e?.message ?? e),
});

const anthropic = inspector.wrap(new FakeAnthropic());

await inspector.trace(
  "POST /api/chat",
  async () => {
    // 1. Prompt assembly
    await inspector.span("build prompt", async (h) => {
      await sleep(8);
      h.setPayload("system", { text: "You are a financial analyst assistant." });
    }, { kind: "prompt_assembly" });

    // 2. Retrieval
    const chunks = await inspector.span("pgvector search", async (h) => {
      await sleep(240);
      const found = [
        { id: "doc_1", score: 0.91, text: "Q3 revenue was $1.2M..." },
        { id: "doc_2", score: 0.84, text: "Year-over-year growth of 18%..." },
        { id: "doc_3", score: 0.77, text: "Operating margin improved..." },
      ];
      h.setPayload("chunks", found);
      h.setAttribute("retrieval.k", found.length);
      return found;
    }, { kind: "retrieval" });

    // 3. Streamed model call — TTFT is captured here
    await inspector.span("answer", async () => {
      const stream = anthropic.messages.stream({
        model: "claude-opus-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: `Context: ${chunks.length} docs. What was Q3 revenue?` }],
      });
      let text = "";
      for await (const ev of stream) {
        if (ev.type === "content_block_delta") text += ev.delta.text;
      }
      return text;
    }, { kind: "agent_step" });

    // 4. Tool call
    const rows = await inspector.span("sql_query", async (h) => {
      await sleep(160);
      h.setPayload("input", { sql: "SELECT SUM(amount) FROM orders WHERE quarter = 'Q3'" });
      h.setPayload("output", { rows: [{ sum: 1_204_338 }] });
      return [{ sum: 1_204_338 }];
    }, { kind: "tool_call" });

    // 5. Follow-up call — fails once, then succeeds (two spans, both visible)
    let final;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        final = await anthropic.messages.create({
          model: "claude-opus-5",
          max_tokens: 512,
          __flaky: true,
          __cached: attempt > 1,
          messages: [{ role: "user", content: `Verify against SQL: ${rows[0].sum}` }],
        });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
    return final;
  },
  { env: "demo", userId: "u_42" },
);

await inspector.shutdown();
console.log("Trace sent. View it with:");
console.log(`  curl -s ${ENDPOINT}/v1/traces?limit=1 | python3 -m json.tool`);
