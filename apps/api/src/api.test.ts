import { createDb, type DbHandle, runMigrations, sessions, tenants, users } from "@traiblazer/db";
import { createGatewayFromEnv } from "@traiblazer/llm";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { hashPassword, verifyPassword } from "./auth/password.js";
import { loadConfig } from "./config.js";

const ownerUrl = process.env.TEST_DATABASE_URL as string;
const appUrl = process.env.TEST_DATABASE_APP_URL as string;

let app: FastifyInstance;
let appDb: DbHandle;
let ownerDb: DbHandle;
const createdEmails: string[] = [];
const createdTenantIds: string[] = [];

const uniqueEmail = (name: string) => {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@test.local`;
  createdEmails.push(email);
  return email;
};

/** Signs up a user and returns a cookie header for later requests. */
async function signup(name: string): Promise<{ cookie: string; email: string }> {
  const email = uniqueEmail(name);
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "correct-horse-battery", name },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.cookies.find((c) => c.name === "tb_session");
  expect(setCookie?.httpOnly).toBe(true);
  return { cookie: `tb_session=${setCookie!.value}`, email };
}

async function createTenant(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/tenants",
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().tenant.id as string;
  createdTenantIds.push(id);
  return id;
}

beforeAll(async () => {
  await runMigrations(ownerUrl);
  ownerDb = createDb(ownerUrl, { max: 1 });
  appDb = createDb(appUrl, { max: 5 });
  const config = loadConfig({ NODE_ENV: "test", AUTH_RATE_LIMIT_PER_MIN: "1000" } as NodeJS.ProcessEnv);
  app = await buildApp({ db: appDb.db, config, gateway: createGatewayFromEnv({}).gateway });
});

afterAll(async () => {
  if (createdTenantIds.length) await ownerDb.db.delete(tenants).where(inArray(tenants.id, createdTenantIds));
  if (createdEmails.length) await ownerDb.db.delete(users).where(inArray(users.email, createdEmails));
  await app?.close();
  await appDb?.close();
  await ownerDb?.close();
});

describe("password hashing", () => {
  it("verifies correct and rejects wrong passwords", async () => {
    const hash = await hashPassword("s3cret-pässword");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret-pässword", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("auth", () => {
  it("signs up, reads the session, logs out", async () => {
    const { cookie, email } = await signup("alice");
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
    expect(me.json().user).not.toHaveProperty("passwordHash");

    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("logs in with the right password only", async () => {
    const { email } = await signup("bob");
    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "wrong-password!" },
    });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "nobody@test.local", password: "whatever-123" },
    });
    expect(unknown.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: email.toUpperCase(), password: "correct-horse-battery" },
    });
    expect(good.statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For unless it comes from a trusted proxy", async () => {
    const sessionIp = async (remoteAddress: string, forwardedFor: string) => {
      const email = uniqueEmail("ip");
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        remoteAddress,
        headers: { "x-forwarded-for": forwardedFor },
        payload: { email, password: "correct-horse-battery", name: "IP" },
      });
      expect(res.statusCode).toBe(201);
      const [row] = await ownerDb.db
        .select({ ip: sessions.ip })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(users.email, email));
      return row?.ip;
    };
    // Sent straight to the API: the header is the visitor's own claim and is ignored.
    expect(await sessionIp("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9");
    // Through a proxy on this machine: the address the proxy saw wins over what the visitor sent.
    expect(await sessionIp("127.0.0.1", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("reads TRUST_PROXY as off, a hop count or a list of proxies", () => {
    const trust = (value?: string) =>
      loadConfig({ ...(value === undefined ? {} : { TRUST_PROXY: value }) } as NodeJS.ProcessEnv).TRUST_PROXY;
    expect(trust()).toEqual(["loopback"]);
    expect(trust("false")).toBe(false);
    expect(trust("2")).toBe(2);
    expect(trust("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
  });

  it("rejects duplicate emails and weak input", async () => {
    const { email } = await signup("carol");
    const dup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password: "correct-horse-battery", name: "Carol" },
    });
    expect(dup.statusCode).toBe(409);
    const weak = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: uniqueEmail("weak"), password: "short", name: "W" },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("validation_error");
  });
});

describe("tenants and bots", () => {
  it("creates a business and a restaurant assistant with profile and widget key", async () => {
    const { cookie } = await signup("owner");
    const tenantId = await createTenant(cookie, "Café Boréal");

    const created = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
      payload: {
        name: "Boréal Assistant",
        pack: "cafe-bakery",
        variant: "bakery",
        languages: ["en", "fr-CA", "zh-CN", "ar"],
        allowedOrigins: ["https://cafe-boreal.example/menu"],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.bot.languages).toEqual(["en", "fr", "zh-Hans", "ar"]);
    expect(body.bot.defaultLanguage).toBe("en");
    expect(body.profile.botId).toBe(body.bot.id);
    expect(body.profile.businessName).toBe("Café Boréal");
    expect(body.bot.hostedPageEnabled).toBe(false);
    expect(body.keys[0].publicKey).toMatch(/^pk_test_/);
    expect(body.keys[0].allowedOrigins).toEqual(["https://cafe-boreal.example"]);

    const list = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
    });
    expect(list.json().bots).toHaveLength(1);

    const profile = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/bots/${body.bot.id}/profile`,
      headers: { cookie },
      payload: {
        phone: "+1 705 555 0199",
        hours: { mon: [{ open: "07:00", close: "15:00" }] },
        staffLanguages: ["en", "fr", "uk"],
      },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().profile.staffLanguages).toEqual(["en", "fr", "uk"]);

    // Time zones must be real: an unknown one would break "current local time" for every chat.
    const setZone = (timezone: string) =>
      app.inject({
        method: "PUT",
        url: `/v1/tenants/${tenantId}/bots/${body.bot.id}/profile`,
        headers: { cookie },
        payload: { timezone },
      });
    expect((await setZone("Mars/Phobos")).statusCode).toBe(400);
    expect((await setZone("America/Winnipeg")).json().profile.timezone).toBe("America/Winnipeg");

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/bots/${body.bot.id}`,
      headers: { cookie },
      payload: { status: "active", defaultLanguage: "fr" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().bot.status).toBe("active");

    const audit = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/audit-logs`,
      headers: { cookie },
    });
    expect(audit.json().entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["tenant.created", "bot.created", "bot.updated"]),
    );
  });

  it("refuses packs that are not released yet and invalid variants", async () => {
    const { cookie } = await signup("picky");
    const tenantId = await createTenant(cookie, "Picky Co");
    const clinic = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
      payload: { name: "x", pack: "clinic" },
    });
    expect(clinic.statusCode).toBe(400);
    const badVariant = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
      payload: { name: "x", pack: "restaurant", variant: "dental" },
    });
    expect(badVariant.statusCode).toBe(400);
    const badLanguage = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/bots`,
      headers: { cookie },
      payload: { name: "x", pack: "restaurant", languages: ["xx"] },
    });
    expect(badLanguage.statusCode).toBe(400);
  });

  it("isolates businesses from each other", async () => {
    const a = await signup("tenant-a");
    const b = await signup("tenant-b");
    const tenantA = await createTenant(a.cookie, "A Shop");
    const botA = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/bots`,
        headers: { cookie: a.cookie },
        payload: { name: "A bot", pack: "retail" },
      })
    ).json().bot.id as string;

    // B is not a member of A: every route answers 404, nothing leaks.
    for (const [method, url] of [
      ["GET", `/v1/tenants/${tenantA}`],
      ["GET", `/v1/tenants/${tenantA}/bots`],
      ["GET", `/v1/tenants/${tenantA}/bots/${botA}`],
      ["DELETE", `/v1/tenants/${tenantA}/bots/${botA}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: b.cookie } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    // B's own tenant can't see A's bot by id either.
    const tenantB = await createTenant(b.cookie, "B Shop");
    const cross = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantB}/bots/${botA}`,
      headers: { cookie: b.cookie },
    });
    expect(cross.statusCode).toBe(404);

    const meB = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: b.cookie } });
    expect(meB.json().tenants.map((t: { id: string }) => t.id)).toEqual([tenantB]);
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tenants" });
    expect(res.statusCode).toBe(401);
  });
});

describe("catalog", () => {
  it("lists launch packs and languages", async () => {
    const packs = await app.inject({ method: "GET", url: "/v1/catalog/packs" });
    expect(packs.json().available.map((p: { slug: string }) => p.slug)).toContain("restaurant");
    expect(packs.json().available.map((p: { slug: string }) => p.slug)).not.toContain("clinic");
    const langs = await app.inject({ method: "GET", url: "/v1/catalog/languages" });
    expect(langs.json().languages.find((l: { code: string }) => l.code === "ar").dir).toBe("rtl");
  });
});
