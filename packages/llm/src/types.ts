/** Provider-neutral chat types used by the conversation engine. */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * System prompt split into blocks, stable content first. Blocks marked `cacheBreakpoint` end a
 * cacheable prefix (used by providers that support prompt caching; ignored by others).
 */
export interface SystemBlock {
  text: string;
  cacheBreakpoint?: boolean;
}

export type Effort = "low" | "medium" | "high";

export interface ChatRequest {
  system: SystemBlock[];
  messages: ChatMessage[];
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end" | "max_tokens" | "refusal";

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: Usage; stopReason: StopReason; model: string };

export interface LLMProvider {
  readonly id: string;
  stream(model: string, request: ChatRequest): AsyncIterable<ChatEvent>;
}

export interface ModelRoute {
  provider: string;
  model: string;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
