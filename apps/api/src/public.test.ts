import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimNextJob, completeJob, syncSource } from "@traiblazer/core";
import { createDb, type DbHandle, jobs, runMigrations, tenants, users } from "@traiblazer/db";
import { createGatewayFromEnv } from "@traiblazer/llm";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const ownerUrl = process.env.TEST_DATABASE_URL as string;
const appUrl = process.env.TEST_DATABASE_APP_URL as string;
const PUBLIC = "http://chat.test.local";

let app: FastifyInstance;
let appDb: DbHandle;
let ownerDb: DbHandle;
let cookie: string;
let tenantId: string;
let botId: string;
let publicKey: string;
let email: string;

const sse = (body: string) =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => JSON.parse(f.slice(5)) as { type: string; [k: string]: unknown });

async function chat(
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/public/chat",
    headers: { origin: PUBLIC, ...headers },
    payload: { publicKey, visitorId: "visitor-1234", message, channel: "hosted", ...extra },
  });
}

beforeAll(async () => {
  await runMigrations(ownerUrl);
  ownerDb = createDb(ownerUrl, { max: 1 });
  appDb = createDb(appUrl, { max: 5 });

  // A fake built chat page so /c/:key can be served without running Vite in tests.
  const dist = await mkdtemp(path.join(tmpdir(), "tb-chat-"));
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=app></div>");
  await writeFile(path.join(dist, "widget.js"), "/* widget */");
  await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log(1)");

  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_RATE_LIMIT_PER_MIN: "1000",
    CHAT_RATE_LIMIT_PER_MIN: "1000",
    PUBLIC_URL: PUBLIC,
    ADMIN_ORIGIN: "http://admin.test.local",
  } as NodeJS.ProcessEnv);
  app = await buildApp({
    db: appDb.db,
    config,
    gateway: createGatewayFromEnv({}).gateway,
    chatDistDir: dist,
  });

  email = `owner-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const signup = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "correct-horse-battery", name: "Owner" },
  });
  cookie = `tb_session=${signup.cookies.find((c) => c.name === "tb_session")!.value}`;
  tenantId = (
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie },
      payload: { name: "Harbour Inn" },
    })
  ).json().tenant.id;
  const created = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/bots`,
    headers: { cookie },
    payload: {
      name: "Harbour Inn Assistant",
      pack: "lodging",
      languages: ["en", "fr", "ar"],
      allowedOrigins: ["https://harbour-inn.example"],
    },
  });
  botId = created.json().bot.id;
  publicKey = created.json().keys[0].publicKey;
});

afterAll(async () => {
  await ownerDb?.db.delete(tenants).where(inArray(tenants.id, [tenantId]));
  await ownerDb?.db.delete(users).where(eq(users.email, email));
  await app?.close();
  await appDb?.close();
  await ownerDb?.close();
});

describe("knowledge management", () => {
  it("adds a text source, queues a sync job, and indexes it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots/${botId}/sources`,
      headers: { cookie },
      payload: {
        type: "text",
        title: "Policies",
        content:
          "Check-in starts at 3 pm and check-out is at 11 am.\n\nPets are welcome for a $20 fee per night.",
      },
    });
    expect(res.statusCode).toBe(201);
    const sourceId = res.json().source.id as string;

    const queued = await ownerDb.db.select().from(jobs).where(eq(jobs.tenantId, tenantId));
    expect(queued.map((j) => j.payload)).toContainEqual({ sourceId });

    // Run the job like the worker does.
    const job = await claimNextJob(appDb.db, "test-worker");
    expect(job?.payload).toEqual({ sourceId });
    await syncSource({ db: appDb.db }, job!.tenantId, sourceId);
    await completeJob(appDb.db, job!.id);

    const list = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/bots/${botId}/sources`,
      headers: { cookie },
    });
    expect(list.json().sources[0]).toMatchObject({ status: "ready", documentCount: 1 });
  });

  it("rejects private website addresses", async () => {
    for (const url of ["http://localhost:8080", "http://192.168.1.10/", "http://printer.local/"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/bots/${botId}/sources`,
        headers: { cookie },
        payload: { type: "website", url },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("adds and lists Q&A pairs", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots/${botId}/qa`,
      headers: { cookie },
      payload: {
        question: "Is breakfast included?",
        answer: "Yes, a continental breakfast is included from 7 to 10 am.",
      },
    });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/bots/${botId}/qa`,
      headers: { cookie },
    });
    expect(list.json().pairs).toHaveLength(1);
  });
});

describe("public chat", () => {
  it("returns the public configuration", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` });
    expect(res.statusCode).toBe(200);
    const bot = res.json().bot;
    // New assistants start with the business's name in their profile.
    expect(bot.businessName).toBe("Harbour Inn");
    expect(bot.languages.map((l: { code: string; dir: string }) => `${l.code}:${l.dir}`)).toEqual([
      "en:ltr",
      "fr:ltr",
      "ar:rtl",
    ]);
    expect(bot.quickReplies.en.length).toBeGreaterThan(0);
  });

  it("streams an answer grounded in the business's information", async () => {
    const res = await chat("What time is check-in?");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = sse(res.body);
    expect(events[0]?.type).toBe("start");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(text).toContain("Check-in starts at 3 pm");
    expect(events.at(-1)?.type).toBe("done");

    // The visitor can restore the conversation, another visitor id cannot.
    const conversationId = events[0]!.conversationId as string;
    const history = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${conversationId}?key=${publicKey}&visitorId=visitor-1234`,
    });
    expect(history.json().messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    const stolen = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${conversationId}?key=${publicKey}&visitorId=someone-else`,
    });
    expect(stolen.statusCode).toBe(404);

    // The owner sees it in the admin.
    const convs = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/bots/${botId}/conversations`,
      headers: { cookie },
    });
    expect(convs.json().conversations[0].id).toBe(conversationId);
  });

  it("uses owner Q&A answers", async () => {
    const events = sse((await chat("Is breakfast included?")).body);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toContain("continental breakfast");
  });

  it("rejects requests from other origins and unknown keys", async () => {
    expect((await chat("hi", {}, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await chat("hi", { publicKey: "pk_test_doesnotexist123" })).statusCode).toBe(404);
    expect((await chat("", {})).statusCode).toBe(400);
  });
});

describe("chat page, iframe and widget", () => {
  const openDirectly = () =>
    app.inject({ method: "GET", url: `/c/${publicKey}`, headers: { "sec-fetch-dest": "document" } });

  it("keeps the web version off until the owner activates it", async () => {
    const closed = await openDirectly();
    expect(closed.statusCode).toBe(404);
    expect(closed.body).toContain("isn't available");
    // Embedding on the business's own site works without the web version.
    const framed = await app.inject({
      method: "GET",
      url: `/c/${publicKey}`,
      headers: { "sec-fetch-dest": "iframe" },
    });
    expect(framed.statusCode).toBe(200);

    const activated = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
      payload: { hostedPageEnabled: true },
    });
    expect(activated.json().bot.hostedPageEnabled).toBe(true);
    expect((await openDirectly()).statusCode).toBe(200);
  });

  it("can activate the web version when the assistant is created", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
      payload: { name: "Contractor web chat", pack: "generic", hostedPageEnabled: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bot.hostedPageEnabled).toBe(true);
    const page = await app.inject({
      method: "GET",
      url: `/c/${res.json().keys[0].publicKey}`,
      headers: { "sec-fetch-dest": "document" },
    });
    expect(page.statusCode).toBe(200);
  });

  it("serves the chat page with frame-ancestors limited to the business's sites", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/c/${publicKey}`,
      headers: { "sec-fetch-dest": "document" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'self' http://admin.test.local https://harbour-inn.example");
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });

  it("can switch the web version off again while iframes keep working", async () => {
    await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
      payload: { hostedPageEnabled: false, settings: { color: "#aa3300" } },
    });
    const direct = await app.inject({
      method: "GET",
      url: `/c/${publicKey}`,
      headers: { "sec-fetch-dest": "document" },
    });
    expect(direct.statusCode).toBe(404);
    const framed = await app.inject({
      method: "GET",
      url: `/c/${publicKey}`,
      headers: { "sec-fetch-dest": "iframe" },
    });
    expect(framed.statusCode).toBe(200);

    const config = await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` });
    expect(config.json().bot.appearance.color).toBe("#aa3300");
  });

  it("serves the widget loader for any site and the hashed assets", async () => {
    const widget = await app.inject({ method: "GET", url: "/widget.js" });
    expect(widget.statusCode).toBe(200);
    expect(widget.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    const asset = await app.inject({ method: "GET", url: "/chat-assets/assets/index-abc.js" });
    expect(asset.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/chat-assets/assets/..%2F..%2Fsecret.js" })).statusCode,
    ).toBe(404);
  });

  it("shows nothing for unknown keys", async () => {
    expect((await app.inject({ method: "GET", url: "/c/pk_test_unknownkey123" })).statusCode).toBe(404);
  });
});

describe("appearance", () => {
  // 1×1 PNG
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const upload = (data: string, who = cookie, tenant = tenantId) =>
    app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant}/assets`,
      headers: { cookie: who },
      payload: { kind: "avatar", data },
    });
  const patchSettings = (settings: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
      payload: { settings },
    });
  const publicConfig = async () =>
    (await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` })).json().bot;

  it("uses safe defaults: classic template, business name, initials", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.json().bot.appearance).toMatchObject({
      theme: "classic",
      assistantName: "Harbour Inn",
      avatar: { kind: "initials", initials: "HI" },
      launcherPosition: "right",
    });
  });

  it("lets the owner pick a template and fully customize name, icon and launcher label", async () => {
    const res = await patchSettings({
      theme: "midnight",
      assistantName: "Captain Mo 🌊",
      avatar: { kind: "icon", icon: "compass" },
      launcherLabel: "Ask Mo",
      launcherPosition: "left",
    });
    expect(res.statusCode).toBe(200);
    expect((await publicConfig()).appearance).toMatchObject({
      theme: "midnight",
      assistantName: "Captain Mo 🌊",
      avatar: { kind: "icon", icon: "compass" },
      launcherLabel: "Ask Mo",
      launcherPosition: "left",
    });
  });

  it("only accepts the designed templates and icons", async () => {
    expect((await patchSettings({ theme: "neon" })).statusCode).toBe(400);
    expect((await patchSettings({ avatar: { kind: "icon", icon: "skull" } })).statusCode).toBe(400);
    expect((await patchSettings({ color: "red" })).statusCode).toBe(400);
    expect((await patchSettings({ assistantName: "x".repeat(41) })).statusCode).toBe(400);
  });

  it("uploads a photo avatar and serves it publicly", async () => {
    const res = await upload(PNG);
    expect(res.statusCode).toBe(201);
    const { id, url } = res.json().asset;
    expect(url).toBe(`${PUBLIC}/v1/public/assets/${id}`);

    expect((await patchSettings({ avatar: { kind: "image", assetId: id } })).statusCode).toBe(200);
    expect((await publicConfig()).appearance.avatar).toEqual({ kind: "image", url });

    const image = await app.inject({ method: "GET", url: `/v1/public/assets/${id}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(image.rawPayload.equals(Buffer.from(PNG, "base64"))).toBe(true);
  });

  it("rejects non-images, SVG and oversized files", async () => {
    expect((await upload(Buffer.from("<svg onload=alert(1)></svg>").toString("base64"))).statusCode).toBe(
      400,
    );
    expect((await upload(Buffer.from("hello").toString("base64"))).statusCode).toBe(400);
    const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(600 * 1024)]).toString("base64");
    expect((await upload(big)).statusCode).toBe(400);
  });

  it("does not let a business use another business's image", async () => {
    const otherEmail = `other-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: otherEmail, password: "correct-horse-battery", name: "Other" },
    });
    const otherCookie = `tb_session=${signup.cookies.find((c) => c.name === "tb_session")!.value}`;
    const otherTenant = (
      await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { cookie: otherCookie },
        payload: { name: "Other" },
      })
    ).json().tenant.id as string;
    const foreign = (await upload(PNG, otherCookie, otherTenant)).json().asset.id as string;

    expect((await patchSettings({ avatar: { kind: "image", assetId: foreign } })).statusCode).toBe(400);
    // Uploading into a business you don't belong to is not possible either.
    expect((await upload(PNG, otherCookie, tenantId)).statusCode).toBe(404);

    await ownerDb.db.delete(tenants).where(eq(tenants.id, otherTenant));
    await ownerDb.db.delete(users).where(eq(users.email, otherEmail));
  });
});

describe("suggested questions", () => {
  const patch = (settings: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
      payload: { settings },
    });
  const quickReplies = async () =>
    (await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` })).json().bot.quickReplies;

  it("shows the industry suggestions by default and returns them to the admin", async () => {
    const detail = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
    });
    const defaults = detail.json().defaults.quickReplies;
    expect(defaults.en.length).toBeGreaterThan(0);
    expect((await quickReplies()).en).toEqual(defaults.en);
  });

  it("uses the owner's questions per language", async () => {
    expect(
      (
        await patch({
          quickReplies: { en: ["Do you have parking?", "Can I bring my dog?"], ar: ["هل يوجد موقف سيارات؟"] },
        })
      ).statusCode,
    ).toBe(200);
    const replies = await quickReplies();
    expect(replies.en).toEqual(["Do you have parking?", "Can I bring my dog?"]);
    expect(replies.ar).toEqual(["هل يوجد موقف سيارات؟"]);
    // Languages the owner didn't customize keep the industry suggestions.
    expect(replies.fr.length).toBeGreaterThan(0);
  });

  it("can hide suggestions with an empty list", async () => {
    await patch({ quickReplies: { en: [], fr: [], ar: [] } });
    const replies = await quickReplies();
    expect(replies.en).toEqual([]);
    expect(replies.fr).toEqual([]);
  });

  it("limits the number and length of questions", async () => {
    expect(
      (await patch({ quickReplies: { en: Array.from({ length: 7 }, (_, i) => `Q${i}`) } })).statusCode,
    ).toBe(400);
    expect((await patch({ quickReplies: { en: ["x".repeat(121)] } })).statusCode).toBe(400);
    expect((await patch({ quickReplies: { en: [""] } })).statusCode).toBe(400);
  });
});

describe("viewing and editing pasted text", () => {
  const sourcesUrl = () => `/v1/tenants/${tenantId}/bots/${botId}/sources`;

  it("shows the pasted text and updates it, then answers from the new version", async () => {
    const created = await app.inject({
      method: "POST",
      url: sourcesUrl(),
      headers: { cookie },
      payload: { type: "text", title: "Winter hours", content: "In winter the sauna opens at 4 pm." },
    });
    const id = created.json().source.id as string;
    await syncSource({ db: appDb.db }, tenantId, id);

    const view = await app.inject({ method: "GET", url: `${sourcesUrl()}/${id}`, headers: { cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json().source).toMatchObject({
      type: "text",
      title: "Winter hours",
      content: "In winter the sauna opens at 4 pm.",
      status: "ready",
    });

    const edited = await app.inject({
      method: "PATCH",
      url: `${sourcesUrl()}/${id}`,
      headers: { cookie },
      payload: { title: "Sauna hours", content: "The sauna is open every evening from 5 pm to 10 pm." },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().source).toMatchObject({ title: "Sauna hours", status: "pending" });
    // A re-index job was queued for the edited text.
    const queued = await ownerDb.db.select().from(jobs).where(eq(jobs.tenantId, tenantId));
    expect(queued.filter((j) => j.payload.sourceId === id && j.status === "queued").length).toBeGreaterThan(
      0,
    );

    await syncSource({ db: appDb.db }, tenantId, id);
    const answer = sse((await chat("When is the sauna open?")).body)
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(answer).toContain("every evening from 5 pm to 10 pm");
    expect(answer).not.toContain("4 pm");
  });

  it("validates edits and only allows editing pasted text", async () => {
    const created = await app.inject({
      method: "POST",
      url: sourcesUrl(),
      headers: { cookie },
      payload: { type: "text", title: "Notes", content: "Some notes." },
    });
    const id = created.json().source.id as string;
    for (const payload of [{}, { content: "" }, { title: "x".repeat(201) }]) {
      const res = await app.inject({
        method: "PATCH",
        url: `${sourcesUrl()}/${id}`,
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const site = await app.inject({
      method: "POST",
      url: sourcesUrl(),
      headers: { cookie },
      payload: { type: "website", url: "https://harbour-inn.example" },
    });
    const siteId = site.json().source.id as string;
    const res = await app.inject({
      method: "PATCH",
      url: `${sourcesUrl()}/${siteId}`,
      headers: { cookie },
      payload: { content: "hacked" },
    });
    expect(res.statusCode).toBe(400);
    const view = await app.inject({ method: "GET", url: `${sourcesUrl()}/${siteId}`, headers: { cookie } });
    expect(view.json()).toMatchObject({ source: { type: "website" }, pages: [] });
  });

  it("is not visible to other businesses", async () => {
    const otherEmail = `peek-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: otherEmail, password: "correct-horse-battery", name: "Peek" },
    });
    const otherCookie = `tb_session=${signup.cookies.find((c) => c.name === "tb_session")!.value}`;
    const list = await app.inject({ method: "GET", url: sourcesUrl(), headers: { cookie } });
    const id = list.json().sources[0].id as string;
    expect(
      (await app.inject({ method: "GET", url: `${sourcesUrl()}/${id}`, headers: { cookie: otherCookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${sourcesUrl()}/${id}`,
          headers: { cookie: otherCookie },
          payload: { content: "nope" },
        })
      ).statusCode,
    ).toBe(404);
    await ownerDb.db.delete(users).where(eq(users.email, otherEmail));
  });
});

describe("general settings: languages", () => {
  const patch = (body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${botId}`,
      headers: { cookie },
      payload: body,
    });
  const publicConfig = async () =>
    (await app.inject({ method: "GET", url: `/v1/public/bots/${publicKey}` })).json().bot;

  it("turns languages on and off, keeping the default among them", async () => {
    const before = await publicConfig();
    const res = await patch({
      languages: ["en", "uk", "ar"],
      defaultLanguage: "uk",
      settings: { answerOtherLanguages: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bot.settings.answerOtherLanguages).toBe(false);
    const config = await publicConfig();
    expect(config.defaultLanguage).toBe("uk");
    expect(config.languages.map((l: { code: string }) => l.code)).toEqual(["en", "uk", "ar"]);
    expect(config.languages.find((l: { code: string }) => l.code === "ar").dir).toBe("rtl");

    // The default language must be one of the languages turned on, and at least one must stay on.
    expect((await patch({ languages: ["en"], defaultLanguage: "uk" })).statusCode).toBe(400);
    expect((await patch({ languages: ["en"] })).statusCode).toBe(400);
    expect((await patch({ languages: [] })).statusCode).toBe(400);
    expect((await patch({ settings: { answerOtherLanguages: "yes" } })).statusCode).toBe(400);

    await patch({
      languages: before.languages.map((l: { code: string }) => l.code),
      defaultLanguage: before.defaultLanguage,
      settings: { answerOtherLanguages: true },
    });
  });
});
