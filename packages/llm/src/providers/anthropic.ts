import Anthropic from "@anthropic-ai/sdk";
import type { ChatEvent, ChatRequest, LLMProvider, StopReason } from "../types.js";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-fable-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Claude through the official Anthropic SDK. */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(options: { apiKey?: string; baseURL?: string } = {}) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL });
  }

  async *stream(model: string, request: ChatRequest): AsyncIterable<ChatEvent> {
    // Stable blocks first; the block flagged as a cache breakpoint ends the cached prefix.
    const system: Anthropic.Beta.BetaTextBlockParam[] = request.system.map((block) => ({
      type: "text",
      text: block.text,
      ...(block.cacheBreakpoint ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const useFallbacks = FALLBACK_MODELS.has(model);
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: request.maxTokens ?? 16000,
        system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        // Thinking stays adaptive (the default); effort controls depth and cost.
        output_config: { effort: request.effort ?? "low" },
        ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    const stopReason: StopReason =
      final.stop_reason === "refusal" ? "refusal" : final.stop_reason === "max_tokens" ? "max_tokens" : "end";
    yield {
      type: "done",
      model: final.model,
      stopReason,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
