import type { ChatEvent, ChatRequest, LLMProvider } from "../types.js";

/**
 * Offline provider for development and tests (no API key, no network, no cost).
 *
 * It does not understand language. For chat it echoes the most relevant sentences found in the
 * prompt's <knowledge> section, so the whole pipeline (retrieval, streaming, citations, logging)
 * can be exercised end to end. For auxiliary calls it returns the last user message unchanged.
 */
export class OfflineProvider implements LLMProvider {
  readonly id = "offline";

  async *stream(model: string, request: ChatRequest): AsyncIterable<ChatEvent> {
    const question = request.messages.at(-1)?.content ?? "";
    const system = request.system.map((b) => b.text).join("\n");
    const text = model === "echo" ? question : answerFromKnowledge(system, question);

    // Stream word by word, like a real model.
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      yield { type: "text", text: piece };
    }
    yield {
      type: "done",
      model: `offline/${model}`,
      stopReason: "end",
      usage: {
        inputTokens: Math.ceil((system.length + question.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from have how i in is it me my of on or our the to we what when where which who why will with you your".split(
    " ",
  ),
);

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 1 && !STOP_WORDS.has(w),
  );
}

function answerFromKnowledge(system: string, question: string): string {
  // The last <knowledge> block holds the retrieved passages (the rules also mention the tag name).
  const start = system.lastIndexOf("<knowledge>");
  const end = system.lastIndexOf("</knowledge>");
  const knowledge = start >= 0 && end > start ? system.slice(start + "<knowledge>".length, end) : "";
  const sentences = knowledge
    .replace(/<[^>]+>/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
  const wanted = new Set(terms(question));
  const scored = sentences
    .map((sentence) => ({ sentence, score: terms(sentence).filter((t) => wanted.has(t)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (!scored.length) {
    return "[Offline test mode] I couldn't find that in this business's information. Please contact the business directly.";
  }
  return `[Offline test mode] ${scored.map((s) => s.sentence).join(" ")}`;
}
