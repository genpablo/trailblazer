import { isIP } from "node:net";
import { enqueueJob, JOB_TYPES, tsvectorSql } from "@traiblazer/core";
import {
  bots,
  conversations,
  documents,
  knowledgeSources,
  messages,
  qaPairs,
  withTenant,
} from "@traiblazer/db";
import { createSourceSchema, qaPairSchema, updateTextSourceSchema } from "@traiblazer/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";
import { requireTenantRole } from "../plugins/auth.js";

type BotParams = { Params: { tenantId: string; botId: string } };
type ItemParams = { Params: { tenantId: string; botId: string; itemId: string } };

/** Quick, DNS-free rejection of obviously private targets; the worker re-checks every request. */
function assertLooksPublic(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host)) {
    throw badRequest("Please enter the public address of your website, e.g. https://www.example.com");
  }
}

export async function knowledgeRoutes(app: FastifyInstance, { db }: AppContext) {
  const base = "/v1/tenants/:tenantId/bots/:botId";

  /** Runs fn in the tenant's scope after checking the bot exists there. */
  const forBot = async <T>(tenantId: string, botId: string, fn: Parameters<typeof withTenant<T>>[2]) => {
    if (!isUuid(botId)) throw notFound("Assistant");
    return withTenant(db, tenantId, async (tx) => {
      const [bot] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).limit(1);
      if (!bot) throw notFound("Assistant");
      return fn(tx);
    });
  };

  // ---- Sources ------------------------------------------------------------------------------

  app.get<BotParams>(`${base}/sources`, { preHandler: requireTenantRole(db, "viewer") }, async (request) => {
    const { tenantId, botId } = request.params;
    const sources = await forBot(tenantId, botId, (tx) =>
      tx
        .select({
          id: knowledgeSources.id,
          type: knowledgeSources.type,
          title: knowledgeSources.title,
          url: knowledgeSources.url,
          status: knowledgeSources.status,
          error: knowledgeSources.error,
          documentCount: knowledgeSources.documentCount,
          lastSyncedAt: knowledgeSources.lastSyncedAt,
          createdAt: knowledgeSources.createdAt,
        })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.botId, botId))
        .orderBy(desc(knowledgeSources.createdAt)),
    );
    return { sources };
  });

  app.post<BotParams>(
    `${base}/sources`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request, reply) => {
      const { tenantId, botId } = request.params;
      const input = createSourceSchema.parse(request.body);
      if (input.type === "website") assertLooksPublic(input.url);

      const source = await forBot(tenantId, botId, async (tx) => {
        const [row] = await tx
          .insert(knowledgeSources)
          .values(
            input.type === "website"
              ? {
                  tenantId,
                  botId,
                  type: "website",
                  title: input.title ?? new URL(input.url).hostname,
                  url: input.url,
                  settings: input.maxPages ? { maxPages: input.maxPages } : {},
                }
              : { tenantId, botId, type: "text", title: input.title, content: input.content },
          )
          .returning();
        await audit(tx, {
          tenantId,
          actorUserId: request.user!.id,
          action: "source.created",
          targetType: "knowledge_source",
          targetId: row!.id,
          metadata: { type: input.type },
        });
        return row!;
      });
      await enqueueJob(db, { tenantId, type: JOB_TYPES.sourceSync, payload: { sourceId: source.id } });
      return reply.code(201).send({ source });
    },
  );

  /** One source with its content: the pasted text, or the list of pages read from a website. */
  app.get<ItemParams>(
    `${base}/sources/:itemId`,
    { preHandler: requireTenantRole(db, "viewer") },
    async (request) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Source");
      return forBot(tenantId, botId, async (tx) => {
        const [source] = await tx
          .select()
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.id, itemId), eq(knowledgeSources.botId, botId)))
          .limit(1);
        if (!source) throw notFound("Source");
        const pages =
          source.type === "website"
            ? await tx
                .select({ title: documents.title, url: documents.url })
                .from(documents)
                .where(eq(documents.sourceId, itemId))
                .orderBy(documents.url)
            : [];
        return {
          source: {
            id: source.id,
            type: source.type,
            title: source.title,
            url: source.url,
            content: source.content,
            status: source.status,
            error: source.error,
            documentCount: source.documentCount,
            lastSyncedAt: source.lastSyncedAt,
            updatedAt: source.updatedAt,
          },
          pages,
        };
      });
    },
  );

  /** Edits pasted text (title and/or content) and re-indexes it in the background. */
  app.patch<ItemParams>(
    `${base}/sources/:itemId`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Source");
      const input = updateTextSourceSchema.parse(request.body);
      const source = await forBot(tenantId, botId, async (tx) => {
        const [current] = await tx
          .select({ type: knowledgeSources.type })
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.id, itemId), eq(knowledgeSources.botId, botId)))
          .limit(1);
        if (!current) throw notFound("Source");
        if (current.type !== "text")
          throw badRequest("Only pasted text can be edited. Refresh websites instead.");
        const [row] = await tx
          .update(knowledgeSources)
          .set({ ...input, status: "pending", error: null })
          .where(eq(knowledgeSources.id, itemId))
          .returning({
            id: knowledgeSources.id,
            type: knowledgeSources.type,
            title: knowledgeSources.title,
            content: knowledgeSources.content,
            status: knowledgeSources.status,
          });
        await audit(tx, {
          tenantId,
          actorUserId: request.user!.id,
          action: "source.updated",
          targetType: "knowledge_source",
          targetId: itemId,
          metadata: { fields: Object.keys(input) },
        });
        return row!;
      });
      await enqueueJob(db, { tenantId, type: JOB_TYPES.sourceSync, payload: { sourceId: itemId } });
      return { source };
    },
  );

  app.post<ItemParams>(
    `${base}/sources/:itemId/sync`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request, reply) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Source");
      await forBot(tenantId, botId, async (tx) => {
        const [row] = await tx
          .update(knowledgeSources)
          .set({ status: "pending", error: null })
          .where(and(eq(knowledgeSources.id, itemId), eq(knowledgeSources.botId, botId)))
          .returning({ id: knowledgeSources.id });
        if (!row) throw notFound("Source");
      });
      await enqueueJob(db, { tenantId, type: JOB_TYPES.sourceSync, payload: { sourceId: itemId } });
      return reply.code(202).send({ queued: true });
    },
  );

  app.delete<ItemParams>(
    `${base}/sources/:itemId`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request, reply) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Source");
      await forBot(tenantId, botId, async (tx) => {
        const deleted = await tx
          .delete(knowledgeSources)
          .where(and(eq(knowledgeSources.id, itemId), eq(knowledgeSources.botId, botId)))
          .returning({ id: knowledgeSources.id });
        if (!deleted.length) throw notFound("Source");
        await audit(tx, {
          tenantId,
          actorUserId: request.user!.id,
          action: "source.deleted",
          targetType: "knowledge_source",
          targetId: itemId,
        });
      });
      return reply.code(204).send();
    },
  );

  // ---- Q&A pairs ----------------------------------------------------------------------------

  app.get<BotParams>(`${base}/qa`, { preHandler: requireTenantRole(db, "viewer") }, async (request) => {
    const { tenantId, botId } = request.params;
    const pairs = await forBot(tenantId, botId, (tx) =>
      tx
        .select({
          id: qaPairs.id,
          question: qaPairs.question,
          answer: qaPairs.answer,
          language: qaPairs.language,
          enabled: qaPairs.enabled,
        })
        .from(qaPairs)
        .where(eq(qaPairs.botId, botId))
        .orderBy(desc(qaPairs.createdAt)),
    );
    return { pairs };
  });

  app.post<BotParams>(
    `${base}/qa`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request, reply) => {
      const { tenantId, botId } = request.params;
      const input = qaPairSchema.parse(request.body);
      const language = input.language ?? "en";
      const pair = await forBot(tenantId, botId, async (tx) => {
        const [row] = await tx
          .insert(qaPairs)
          .values({
            tenantId,
            botId,
            question: input.question,
            answer: input.answer,
            language,
            tsv: tsvectorSql(`${input.question}\n${input.answer}`, language) as unknown as string,
          })
          .returning({
            id: qaPairs.id,
            question: qaPairs.question,
            answer: qaPairs.answer,
            language: qaPairs.language,
            enabled: qaPairs.enabled,
          });
        return row!;
      });
      return reply.code(201).send({ pair });
    },
  );

  app.delete<ItemParams>(
    `${base}/qa/:itemId`,
    { preHandler: requireTenantRole(db, "editor") },
    async (request, reply) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Answer");
      await forBot(tenantId, botId, async (tx) => {
        const deleted = await tx
          .delete(qaPairs)
          .where(and(eq(qaPairs.id, itemId), eq(qaPairs.botId, botId)))
          .returning({ id: qaPairs.id });
        if (!deleted.length) throw notFound("Answer");
      });
      return reply.code(204).send();
    },
  );

  // ---- Conversations (read-only) ------------------------------------------------------------

  app.get<BotParams>(
    `${base}/conversations`,
    { preHandler: requireTenantRole(db, "viewer") },
    async (request) => {
      const { tenantId, botId } = request.params;
      const list = await forBot(tenantId, botId, (tx) =>
        tx
          .select()
          .from(conversations)
          .where(eq(conversations.botId, botId))
          .orderBy(desc(conversations.lastMessageAt))
          .limit(50),
      );
      return { conversations: list };
    },
  );

  app.get<ItemParams>(
    `${base}/conversations/:itemId`,
    { preHandler: requireTenantRole(db, "viewer") },
    async (request) => {
      const { tenantId, botId, itemId } = request.params;
      if (!isUuid(itemId)) throw notFound("Conversation");
      return forBot(tenantId, botId, async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.id, itemId), eq(conversations.botId, botId)))
          .limit(1);
        if (!conversation) throw notFound("Conversation");
        const rows = await tx
          .select()
          .from(messages)
          .where(eq(messages.conversationId, itemId))
          .orderBy(messages.createdAt);
        return { conversation, messages: rows };
      });
    },
  );
}
