import {
  bots,
  businessProfiles,
  type Channel,
  type Citation,
  conversations,
  type Db,
  type MessageFlags,
  messages,
  usageEvents,
  withTenant,
} from "@traiblazer/db";
import type { EmbeddingProvider, GatewayResultMeta, LLMGateway } from "@traiblazer/llm";
import { and, desc, eq, sql } from "drizzle-orm";
import { guessLanguage, isEnOrFr } from "./language.js";
import { buildSearchQueryPrompt, buildSystemBlocks, parseSearchQueries } from "./prompt.js";
import { type Passage, retrievePassages } from "./retrieval.js";

export interface ChatDeps {
  db: Db;
  gateway: LLMGateway;
  embeddings?: EmbeddingProvider | null;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ChatInput {
  tenantId: string;
  botId: string;
  conversationId?: string | null;
  visitorId: string;
  channel: Channel;
  message: string;
  pageUrl?: string | null;
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: "start"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "done"; messageId: string; citations: Citation[]; flags: MessageFlags }
  | { type: "error"; code: "unavailable" | "failed"; message: string };

const HISTORY_TURNS = 10;
export const MAX_MESSAGE_LENGTH = 2000;

const FALLBACK_TEXT: Record<string, string> = {
  en: "Sorry, I can't help with that here. Please contact the business directly.",
  fr: "Désolé, je ne peux pas vous aider avec cela ici. Veuillez communiquer directement avec l'entreprise.",
};
const ERROR_TEXT: Record<string, string> = {
  en: "Sorry, something went wrong. Please try again in a moment.",
  fr: "Désolé, une erreur s'est produite. Veuillez réessayer dans un instant.",
};

/** Sources shown under an answer: distinct web pages among the passages, best first. */
export function citationsFrom(passages: Passage[], max = 3): Citation[] {
  // Only cite pages that matched about as strongly as the best passage; weak matches are context,
  // not the source of the answer.
  const best = passages[0]?.score ?? 0;
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const p of passages) {
    if (p.score < best * 0.6) break;
    if (p.kind !== "page" || !p.url || seen.has(p.url)) continue;
    seen.add(p.url);
    out.push({ kind: "page", title: p.title, url: p.url });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Answers one visitor message: logs it, finds relevant business information, streams the reply,
 * and records the answer with usage and cost. Everything runs under the bot's tenant (RLS).
 */
export async function* runChat(deps: ChatDeps, input: ChatInput): AsyncGenerator<ChatStreamEvent> {
  const started = Date.now();
  const message = input.message.trim().slice(0, MAX_MESSAGE_LENGTH);
  const language = guessLanguage(message);
  const lang2 = language === "fr" ? "fr" : "en";

  // 1. Load bot + profile, resume or start the conversation, store the visitor's message.
  const setup = await withTenant(deps.db, input.tenantId, async (tx) => {
    const [bot] = await tx.select().from(bots).where(eq(bots.id, input.botId)).limit(1);
    if (!bot || bot.status === "paused") return null;
    const [profile] = await tx
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.botId, bot.id))
      .limit(1);

    let conversation = input.conversationId
      ? (
          await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.id, input.conversationId),
                eq(conversations.botId, bot.id),
                eq(conversations.visitorId, input.visitorId),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    if (!conversation) {
      [conversation] = await tx
        .insert(conversations)
        .values({
          tenantId: input.tenantId,
          botId: bot.id,
          channel: input.channel,
          visitorId: input.visitorId,
          language,
          pageUrl: input.pageUrl?.slice(0, 2000) ?? null,
        })
        .returning();
    }

    const history = (
      await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversation!.id))
        .orderBy(desc(messages.createdAt))
        .limit(HISTORY_TURNS * 2)
    ).reverse();

    await tx.insert(messages).values({
      tenantId: input.tenantId,
      conversationId: conversation!.id,
      role: "user",
      content: message,
      language,
    });
    await tx
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + 1`,
        lastMessageAt: new Date(),
        language: language ?? conversation!.language,
      })
      .where(eq(conversations.id, conversation!.id));

    return { bot, profile: profile ?? null, conversationId: conversation!.id, history };
  });

  if (!setup) {
    yield { type: "error", code: "unavailable", message: "This assistant is not available right now." };
    return;
  }
  const { bot, profile, conversationId, history } = setup;
  yield { type: "start", conversationId };

  let answer = "";
  let chatMeta: GatewayResultMeta | undefined;
  let auxMeta: GatewayResultMeta | undefined;
  let citations: Citation[] = [];
  const flags: MessageFlags = {};

  try {
    // 2. Search queries: rewrite follow-ups and translate other languages into EN/FR.
    let queries = [message];
    if (history.length || !isEnOrFr(language)) {
      const aux = await deps.gateway.complete("aux", {
        ...buildSearchQueryPrompt(history, message),
        maxTokens: 2000,
        effort: "low",
        signal: input.signal,
      });
      auxMeta = aux;
      queries = parseSearchQueries(aux.text, message);
    }

    // 3. Retrieve business information.
    const embedding = deps.embeddings
      ? {
          vector: (await deps.embeddings.embed([queries.join("\n")], "query"))[0]!,
          model: deps.embeddings.model,
        }
      : null;
    const passages = await withTenant(deps.db, input.tenantId, (tx) =>
      retrievePassages(tx, { botId: bot.id, queries, embedding }),
    );
    citations = citationsFrom(passages);
    if (!passages.length) flags.unanswered = true;

    // 4. Stream the answer.
    for await (const event of deps.gateway.stream("chat", {
      system: buildSystemBlocks({ bot, profile, passages, now: deps.now?.() ?? new Date() }),
      messages: [...history, { role: "user", content: message }],
      maxTokens: 16000,
      effort: "low",
      signal: input.signal,
    })) {
      if (event.type === "text") {
        answer += event.text;
        yield { type: "text", text: event.text };
      } else {
        chatMeta = event;
      }
    }

    if (chatMeta?.stopReason === "refusal" || !answer.trim()) {
      flags.refused = chatMeta?.stopReason === "refusal" || undefined;
      const fallback = FALLBACK_TEXT[lang2]!;
      yield { type: "text", text: answer ? `\n\n${fallback}` : fallback };
      answer = answer ? `${answer}\n\n${fallback}` : fallback;
      citations = [];
    }
  } catch (error) {
    if (input.signal?.aborted) return;
    deps.log?.("chat failed", {
      error: error instanceof Error ? error.message : String(error),
      botId: bot.id,
    });
    flags.error = true;
    const text = ERROR_TEXT[lang2]!;
    if (!answer) yield { type: "text", text };
    answer = answer || text;
    citations = [];
  }

  // 5. Store the answer, usage and cost.
  const messageId = await withTenant(deps.db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        tenantId: input.tenantId,
        conversationId,
        role: "assistant",
        content: answer,
        language,
        citations,
        flags,
        provider: chatMeta?.provider,
        model: chatMeta?.model,
        inputTokens: chatMeta?.usage.inputTokens,
        outputTokens: chatMeta?.usage.outputTokens,
        cacheReadTokens: chatMeta?.usage.cacheReadTokens,
        cacheWriteTokens: chatMeta?.usage.cacheWriteTokens,
        costMicros: (chatMeta?.costMicros ?? 0) + (auxMeta?.costMicros ?? 0),
        latencyMs: Date.now() - started,
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({ messageCount: sql`${conversations.messageCount} + 1`, lastMessageAt: new Date() })
      .where(eq(conversations.id, conversationId));

    const usage = [
      chatMeta && { kind: "llm.chat", meta: chatMeta },
      auxMeta && { kind: "llm.aux", meta: auxMeta },
    ].filter(Boolean) as { kind: string; meta: GatewayResultMeta }[];
    if (usage.length) {
      await tx.insert(usageEvents).values(
        usage.map(({ kind, meta }) => ({
          tenantId: input.tenantId,
          botId: bot.id,
          kind,
          quantity: meta.usage.inputTokens + meta.usage.outputTokens,
          costMicros: meta.costMicros,
          metadata: { provider: meta.provider, model: meta.model, ...meta.usage },
        })),
      );
    }
    return row!.id;
  });

  yield { type: "done", messageId, citations, flags };
}
