import { describe, expect, it } from "vitest";
import { createGatewayFromEnv } from "./config.js";
import { LLMGateway, parseRoutes } from "./gateway.js";
import { costMicros } from "./pricing.js";
import { OfflineProvider } from "./providers/offline.js";
import type { ChatEvent, ChatRequest, LLMProvider } from "./types.js";

class FailingProvider implements LLMProvider {
  readonly id = "failing";
  calls = 0;
  constructor(private readonly afterText = false) {}
  async *stream(): AsyncIterable<ChatEvent> {
    this.calls++;
    if (this.afterText) yield { type: "text", text: "partial " };
    throw new Error("provider down");
  }
}

const request = (question: string, knowledge = ""): ChatRequest => ({
  // The rules mention the tag name too; the offline provider must read the last block.
  system: [
    { text: `Answer only from <knowledge>. Never use outside facts.\n<knowledge>${knowledge}</knowledge>` },
  ],
  messages: [{ role: "user", content: question }],
});

async function collect(gateway: LLMGateway, req: ChatRequest) {
  let text = "";
  let done: unknown;
  for await (const e of gateway.stream("chat", req)) {
    if (e.type === "text") text += e.text;
    else done = e;
  }
  return { text, done };
}

describe("LLM gateway", () => {
  it("parses routes", () => {
    expect(parseRoutes("anthropic:claude-opus-5-5, openrouter:vendor/model:free")).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "openrouter", model: "vendor/model:free" },
    ]);
    expect(() => parseRoutes("nocolon")).toThrow();
  });

  it("falls back to the next route when a provider fails before any text", async () => {
    const failing = new FailingProvider();
    const fallbacks: string[] = [];
    const gateway = new LLMGateway({
      providers: [failing, new OfflineProvider()],
      routes: {
        chat: [
          { provider: "failing", model: "x" },
          { provider: "offline", model: "knowledge" },
        ],
        aux: [{ provider: "offline", model: "echo" }],
      },
      onFallback: ({ to }) => fallbacks.push(to.provider),
    });
    const { text, done } = await collect(gateway, request("When do you open?", "We open at 9 am every day."));
    expect(failing.calls).toBe(1);
    expect(fallbacks).toEqual(["offline"]);
    expect(text).toContain("We open at 9 am every day.");
    expect(done).toMatchObject({ provider: "offline", stopReason: "end" });
  });

  it("does not switch providers after text has streamed", async () => {
    const gateway = new LLMGateway({
      providers: [new FailingProvider(true), new OfflineProvider()],
      routes: {
        chat: [
          { provider: "failing", model: "x" },
          { provider: "offline", model: "knowledge" },
        ],
        aux: [{ provider: "offline", model: "echo" }],
      },
    });
    await expect(collect(gateway, request("hi"))).rejects.toThrow("provider down");
  });

  it("rejects routes to unknown providers", () => {
    expect(
      () =>
        new LLMGateway({
          providers: [new OfflineProvider()],
          routes: { chat: [{ provider: "nope", model: "m" }], aux: [{ provider: "offline", model: "echo" }] },
        }),
    ).toThrow(/unknown provider/);
  });

  it("uses the offline provider when no keys are configured", async () => {
    const { gateway, offline } = createGatewayFromEnv({});
    expect(offline).toBe(true);
    const aux = await gateway.complete("aux", request("rewrite me"));
    expect(aux.text).toBe("rewrite me");
  });

  it("routes to Claude when an Anthropic key is present", () => {
    const { gateway, offline } = createGatewayFromEnv({ ANTHROPIC_API_KEY: "test" });
    expect(offline).toBe(false);
    expect(gateway.routes("chat")).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
    expect(gateway.routes("aux")).toEqual([{ provider: "anthropic", model: "claude-haiku-5-5" }]);
  });
});

describe("pricing", () => {
  it("computes micro-USD including cache reads and writes", () => {
    const micros = costMicros(
      { provider: "anthropic", model: "claude-opus-5-5" },
      { inputTokens: 4000, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0 },
    );
    // 4000*4 + 400*20 + 1000*0.4 = 16000 + 8000 + 400
    expect(micros).toBe(24400);
    expect(
      costMicros(
        { provider: "offline", model: "x" },
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ),
    ).toBe(0);
  });
});
