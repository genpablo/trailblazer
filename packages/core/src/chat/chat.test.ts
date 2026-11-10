import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bots,
  businessProfiles,
  createDb,
  type DbHandle,
  knowledgeSources,
  messages,
  qaPairs,
  runMigrations,
  tenants,
  usageEvents,
  withTenant,
} from "@traiblazer/db";
import { LLMGateway, type LLMProvider, OfflineProvider } from "@traiblazer/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tsvectorSql } from "../knowledge/index-documents.js";
import { syncSource } from "../knowledge/sync.js";
import { type ChatStreamEvent, runChat } from "./engine.js";
import { retrievePassages } from "./retrieval.js";

const ownerUrl = process.env.TEST_DATABASE_URL as string;
const appUrl = process.env.TEST_DATABASE_APP_URL as string;

let owner: DbHandle;
let app: DbHandle;
let server: Server;
let siteUrl: string;
let tenantId: string;
let botId: string;
let otherTenantId: string;
let otherBotId: string;

const site: Record<string, string> = {
  "/robots.txt": "User-agent: *\nDisallow: /private\n",
  "/": `<html lang="en"><body><main><h1>Northern Lights Café</h1><p>Cozy café on the Thunder Bay waterfront.</p>
        <a href="/hours">Hours</a> <a href="/menu">Menu</a> <a href="/private/secret">Secret</a></main></body></html>`,
  "/hours": `<html lang="en"><body><main><h1>Hours</h1><p>We are open Monday to Friday from 7 am to 4 pm, and Saturday 8 am to 2 pm. Closed Sundays.</p></main></body></html>`,
  "/menu": `<html lang="en"><body><main><h1>Menu</h1><p>Our famous blueberry pie is baked fresh every morning.</p><p>Oat milk is available for all coffee drinks.</p></main></body></html>`,
  "/private/secret": `<html><body><p>This page must never be crawled because robots.txt disallows it.</p></body></html>`,
};

const gateway = new LLMGateway({
  providers: [new OfflineProvider()],
  routes: {
    chat: [{ provider: "offline", model: "knowledge" }],
    aux: [{ provider: "offline", model: "echo" }],
  },
});

async function collect(gen: AsyncGenerator<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  const text = events
    .filter((e): e is Extract<ChatStreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  return {
    events,
    text,
    done: events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>,
  };
}

beforeAll(async () => {
  await runMigrations(ownerUrl);
  owner = createDb(ownerUrl, { max: 2 });
  app = createDb(appUrl, { max: 4 });

  server = createServer((req, res) => {
    const body = site[req.url ?? ""];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const suffix = crypto.randomUUID().slice(0, 8);
  const [t] = await owner.db
    .insert(tenants)
    .values({ name: "Café", slug: `cafe-${suffix}` })
    .returning();
  const [o] = await owner.db
    .insert(tenants)
    .values({ name: "Other", slug: `other-${suffix}` })
    .returning();
  tenantId = t!.id;
  otherTenantId = o!.id;
  const [b] = await owner.db
    .insert(bots)
    .values({ tenantId, name: "Café bot", pack: "cafe-bakery", languages: ["en", "fr"] })
    .returning();
  const [ob] = await owner.db
    .insert(bots)
    .values({ tenantId: otherTenantId, name: "Other bot", pack: "retail" })
    .returning();
  botId = b!.id;
  otherBotId = ob!.id;
  await owner.db
    .insert(businessProfiles)
    .values({ tenantId, botId, businessName: "Northern Lights Café", phone: "807-555-0123" });
});

afterAll(async () => {
  await owner?.db.delete(tenants).where(eq(tenants.id, tenantId));
  await owner?.db.delete(tenants).where(eq(tenants.id, otherTenantId));
  await new Promise((r) => server?.close(r));
  await app?.close();
  await owner?.close();
});

describe("website sync", () => {
  it("crawls the site, respects robots.txt and indexes the pages", async () => {
    const [source] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({
          tenantId,
          botId,
          type: "website",
          title: "Website",
          url: siteUrl,
          settings: { maxPages: 10 },
        })
        .returning(),
    );
    await syncSource({ db: app.db, crawl: { allowPrivate: true, delayMs: 0 } }, tenantId, source!.id);

    const [after] = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source!.id)),
    );
    expect(after!.status).toBe("ready");
    expect(after!.documentCount).toBe(3);

    // Re-sync: unchanged pages are kept, nothing duplicated.
    await syncSource({ db: app.db, crawl: { allowPrivate: true, delayMs: 0 } }, tenantId, source!.id);
    const passages = await withTenant(app.db, tenantId, (tx) =>
      retrievePassages(tx, { botId, queries: ["secret page robots"] }),
    );
    expect(passages.some((p) => p.content.includes("never be crawled"))).toBe(false);

    const usage = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(usageEvents).where(eq(usageEvents.kind, "crawl.page")),
    );
    expect(usage.length).toBe(2);
  });

  it("marks a source as failed when nothing can be read", async () => {
    const [source] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId, botId, type: "website", title: "Broken", url: `${siteUrl}missing` })
        .returning(),
    );
    await expect(
      syncSource({ db: app.db, crawl: { allowPrivate: true, delayMs: 0 } }, tenantId, source!.id),
    ).rejects.toThrow();
    const [after] = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, source!.id)),
    );
    expect(after!.status).toBe("failed");
    // Clean up so later retrieval isn't affected.
    await withTenant(app.db, tenantId, (tx) =>
      tx.delete(knowledgeSources).where(eq(knowledgeSources.id, source!.id)),
    );
  });

  it("refuses private addresses unless explicitly allowed", async () => {
    const [source] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId, botId, type: "website", title: "Local", url: siteUrl })
        .returning(),
    );
    await expect(syncSource({ db: app.db, crawl: { delayMs: 0 } }, tenantId, source!.id)).rejects.toThrow();
    await withTenant(app.db, tenantId, (tx) =>
      tx.delete(knowledgeSources).where(eq(knowledgeSources.id, source!.id)),
    );
  });
});

describe("retrieval", () => {
  it("finds the right page for a question", async () => {
    const passages = await withTenant(app.db, tenantId, (tx) =>
      retrievePassages(tx, { botId, queries: ["When are you open on Saturday?"] }),
    );
    expect(passages[0]?.content).toContain("Saturday 8 am to 2 pm");
    expect(passages[0]?.url).toMatch(/\/hours$/);
  });

  it("ranks owner Q&A pairs first", async () => {
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(qaPairs).values({
        tenantId,
        botId,
        question: "Do you have gluten-free options?",
        answer: "Yes, we bake gluten-free muffins every Friday.",
        tsv: tsvectorSql(
          "Do you have gluten-free options? Yes, we bake gluten-free muffins every Friday.",
          "en",
        ) as unknown as string,
      }),
    );
    const passages = await withTenant(app.db, tenantId, (tx) =>
      retrievePassages(tx, { botId, queries: ["Do you have gluten free options?"] }),
    );
    expect(passages[0]?.kind).toBe("qa");
  });

  it("ignores a Q&A pair that only shares common words with the question", async () => {
    const passages = await withTenant(app.db, tenantId, (tx) =>
      retrievePassages(tx, { botId, queries: ["Do you have oat milk?"] }),
    );
    expect(passages.filter((p) => p.kind === "qa")).toEqual([]);
    expect(passages[0]?.url).toMatch(/\/menu$/);
  });

  it("matches a Q&A pair for a paraphrase, and for a follow-up rewritten into several queries", async () => {
    for (const queries of [
      ["Are there gluten-free options?"],
      ["gluten free?"],
      ["and without gluten?", "gluten-free options", "options sans gluten"],
    ]) {
      const passages = await withTenant(app.db, tenantId, (tx) => retrievePassages(tx, { botId, queries }));
      expect(passages[0]?.kind, queries.join(" / ")).toBe("qa");
    }
  });

  it("never returns another tenant's knowledge", async () => {
    const passages = await withTenant(app.db, otherTenantId, (tx) =>
      retrievePassages(tx, { botId, queries: ["blueberry pie"] }),
    );
    expect(passages).toHaveLength(0);
    const own = await withTenant(app.db, otherTenantId, (tx) =>
      retrievePassages(tx, { botId: otherBotId, queries: ["blueberry pie"] }),
    );
    expect(own).toHaveLength(0);
  });
});

describe("chat engine", () => {
  it("streams a grounded answer with sources and logs the conversation", async () => {
    const { events, text, done } = await collect(
      runChat(
        { db: app.db, gateway },
        { tenantId, botId, visitorId: "v1", channel: "hosted", message: "Is the blueberry pie fresh?" },
      ),
    );
    expect(events[0]?.type).toBe("start");
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    expect(text).toContain("blueberry pie is baked fresh every morning");
    expect(done.citations[0]?.url).toMatch(/\/menu$/);
    expect(done.flags.unanswered).toBeUndefined();

    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const stored = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, conversationId)),
    );
    expect(stored.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    expect(stored.find((m) => m.role === "assistant")?.provider).toBe("offline");

    // Follow-up in the same conversation keeps the thread.
    const second = await collect(
      runChat(
        { db: app.db, gateway },
        {
          tenantId,
          botId,
          conversationId,
          visitorId: "v1",
          channel: "hosted",
          message: "Do you have oat milk?",
        },
      ),
    );
    expect((second.events[0] as { conversationId: string }).conversationId).toBe(conversationId);
    expect(second.text).toContain("Oat milk");
  });

  it("does not resume another visitor's conversation", async () => {
    const first = await collect(
      runChat(
        { db: app.db, gateway },
        { tenantId, botId, visitorId: "alice", channel: "widget", message: "hours?" },
      ),
    );
    const conversationId = (first.events[0] as { conversationId: string }).conversationId;
    const other = await collect(
      runChat(
        { db: app.db, gateway },
        { tenantId, botId, conversationId, visitorId: "mallory", channel: "widget", message: "hours?" },
      ),
    );
    expect((other.events[0] as { conversationId: string }).conversationId).not.toBe(conversationId);
  });

  it("flags questions with no matching information", async () => {
    const { done } = await collect(
      runChat(
        { db: app.db, gateway },
        { tenantId, botId, visitorId: "v2", channel: "hosted", message: "zzqx vvkp" },
      ),
    );
    expect(done.flags.unanswered).toBe(true);
  });

  it("still answers when query rewriting or embeddings fail", async () => {
    const failing: LLMProvider = {
      id: "failing",
      // biome-ignore lint/correctness/useYield: fails before producing anything
      async *stream() {
        throw new Error("aux provider down");
      },
    };
    const auxDown = new LLMGateway({
      providers: [new OfflineProvider(), failing],
      routes: {
        chat: [{ provider: "offline", model: "knowledge" }],
        aux: [{ provider: "failing", model: "x" }],
      },
    });
    const embeddings = {
      model: "broken-embeddings",
      embed: async () => {
        throw new Error("embeddings down");
      },
    };
    const logged: string[] = [];
    const deps = { db: app.db, gateway: auxDown, embeddings, log: (msg: string) => logged.push(msg) };

    const first = await collect(
      runChat(deps, { tenantId, botId, visitorId: "v3", channel: "hosted", message: "Is the pie fresh?" }),
    );
    const conversationId = (first.events[0] as { conversationId: string }).conversationId;
    // The follow-up needs a rewrite (there is history); the rewrite fails and is skipped.
    const second = await collect(
      runChat(deps, {
        tenantId,
        botId,
        conversationId,
        visitorId: "v3",
        channel: "hosted",
        message: "Do you have oat milk?",
      }),
    );
    expect(second.text).toContain("Oat milk");
    expect(second.done.flags.error).toBeUndefined();
    expect(logged).toEqual(expect.arrayContaining([expect.stringContaining("rewrite failed")]));
    expect(logged).toEqual(expect.arrayContaining([expect.stringContaining("embedding failed")]));
  });

  it("stores what was written when the time limit stops an answer", async () => {
    const stalls: LLMProvider = {
      id: "stalls",
      async *stream() {
        yield { type: "text", text: "We are open" };
        throw new Error("This operation was aborted");
      },
    };
    const stalling = new LLMGateway({
      providers: [new OfflineProvider(), stalls],
      routes: { chat: [{ provider: "stalls", model: "x" }], aux: [{ provider: "offline", model: "echo" }] },
    });
    const { events, done } = await collect(
      runChat(
        { db: app.db, gateway: stalling },
        {
          tenantId,
          botId,
          visitorId: "v4",
          channel: "hosted",
          message: "When are you open?",
          signal: AbortSignal.abort(),
        },
      ),
    );
    expect(done.flags.error).toBe(true);
    const conversationId = (events[0] as { conversationId: string }).conversationId;
    const stored = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, conversationId)),
    );
    expect(stored.find((m) => m.role === "assistant")?.content).toBe("We are open");
  });

  it("refuses paused bots", async () => {
    await owner.db.update(bots).set({ status: "paused" }).where(eq(bots.id, otherBotId));
    const { events } = await collect(
      runChat(
        { db: app.db, gateway },
        { tenantId: otherTenantId, botId: otherBotId, visitorId: "v", channel: "hosted", message: "hi" },
      ),
    );
    expect(events).toEqual([{ type: "error", code: "unavailable", message: expect.any(String) }]);
  });
});
