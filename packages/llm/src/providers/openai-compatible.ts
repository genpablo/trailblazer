import OpenAI from "openai";
import type { ChatEvent, ChatRequest, LLMProvider, StopReason } from "../types.js";
import { emptyUsage } from "../types.js";

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenRouter, OpenAI, Azure OpenAI (v1 endpoint),
 * Groq, Mistral, Together, Ollama, vLLM, LM Studio.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(
    readonly id: string,
    options: { apiKey: string; baseURL: string; headers?: Record<string, string> },
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.headers,
    });
  }

  async *stream(model: string, request: ChatRequest): AsyncIterable<ChatEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxTokens ?? 4000,
        messages: [
          { role: "system", content: request.system.map((b) => b.text).join("\n\n") },
          ...request.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      },
      { signal: request.signal },
    );

    const usage = emptyUsage();
    let finish: string | null = null;
    let servedModel = model;
    for await (const chunk of stream) {
      servedModel = chunk.model || servedModel;
      const choice = chunk.choices[0];
      const text = choice?.delta?.content;
      if (text) yield { type: "text", text };
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }

    const stopReason: StopReason =
      finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end";
    yield { type: "done", model: servedModel, stopReason, usage };
  }
}
