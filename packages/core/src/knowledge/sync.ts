import { type Db, knowledgeSources, usageEvents, withTenant } from "@traiblazer/db";
import type { EmbeddingProvider } from "@traiblazer/llm";
import { eq } from "drizzle-orm";
import { type CrawlOptions, crawlSite } from "./crawl.js";
import { type IncomingDocument, indexDocuments } from "./index-documents.js";

export interface SyncDeps {
  db: Db;
  embeddings?: EmbeddingProvider | null;
  crawl?: Pick<CrawlOptions, "allowPrivate" | "delayMs" | "timeoutMs">;
}

export const DEFAULT_MAX_PAGES = 50;

/**
 * Re-reads a knowledge source and re-indexes it. The (slow) website crawl happens outside any
 * database transaction; indexing runs in one tenant-scoped transaction.
 */
export async function syncSource(deps: SyncDeps, tenantId: string, sourceId: string): Promise<void> {
  const source = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId)).limit(1);
    if (row) {
      await tx
        .update(knowledgeSources)
        .set({ status: "processing", error: null })
        .where(eq(knowledgeSources.id, sourceId));
    }
    return row;
  });
  if (!source) return; // deleted meanwhile

  try {
    let docs: IncomingDocument[];
    if (source.type === "website") {
      const pages = await crawlSite(source.url!, {
        ...deps.crawl,
        maxPages: source.settings.maxPages ?? DEFAULT_MAX_PAGES,
      });
      if (!pages.length) throw new Error("No readable pages were found at this address.");
      docs = pages.map((p) => ({
        url: p.url,
        title: p.title,
        language: p.language,
        sections: p.sections,
        text: p.text,
      }));
    } else if (source.type === "text") {
      const text = source.content ?? "";
      const sections = text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => ({ heading: null, text: block }));
      docs = [{ url: `text:${source.id}`, title: source.title, language: null, sections, text }];
    } else {
      throw new Error(`Source type "${source.type}" is not synced by the worker`);
    }

    await withTenant(deps.db, tenantId, async (tx) => {
      const result = await indexDocuments(tx, {
        tenantId,
        botId: source.botId,
        sourceId,
        docs,
        removeMissing: true,
        embeddings: deps.embeddings,
      });
      await tx
        .update(knowledgeSources)
        .set({ status: "ready", error: null, documentCount: result.documents, lastSyncedAt: new Date() })
        .where(eq(knowledgeSources.id, sourceId));
      if (source.type === "website") {
        await tx.insert(usageEvents).values({
          tenantId,
          botId: source.botId,
          kind: "crawl.page",
          quantity: docs.length,
          metadata: { sourceId, changed: result.changed },
        });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(knowledgeSources)
        .set({ status: "failed", error: message.slice(0, 500) })
        .where(eq(knowledgeSources.id, sourceId)),
    );
    throw error;
  }
}
