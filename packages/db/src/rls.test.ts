import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle, resolveBotKey, withTenant } from "./client.js";
import { runMigrations } from "./migrator.js";
import { botKeys, bots, businessProfiles, tenants } from "./schema.js";

const ownerUrl = process.env.TEST_DATABASE_URL as string;
const appUrl = process.env.TEST_DATABASE_APP_URL as string;

let owner: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let botB: string;

beforeAll(async () => {
  await runMigrations(ownerUrl);
  owner = createDb(ownerUrl, { max: 2 });
  app = createDb(appUrl, { max: 2 });

  const suffix = crypto.randomUUID().slice(0, 8);
  const [a] = await owner.db
    .insert(tenants)
    .values({ name: "A", slug: `a-${suffix}` })
    .returning();
  const [b] = await owner.db
    .insert(tenants)
    .values({ name: "B", slug: `b-${suffix}` })
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;

  await owner.db.insert(bots).values({ tenantId: tenantA, name: "Bot A", pack: "restaurant" });
  const [bb] = await owner.db
    .insert(bots)
    .values({ tenantId: tenantB, name: "Bot B", pack: "retail" })
    .returning();
  botB = bb!.id;
  await owner.db.insert(botKeys).values({
    tenantId: tenantB,
    botId: botB,
    publicKey: `pk_test_${suffix}`,
    allowedOrigins: ["https://b.example"],
  });
});

afterAll(async () => {
  await owner?.db.delete(tenants).where(eq(tenants.id, tenantA));
  await owner?.db.delete(tenants).where(eq(tenants.id, tenantB));
  await app?.close();
  await owner?.close();
});

describe("row-level security", () => {
  it("app role is not allowed to bypass RLS", async () => {
    const rows = await app.db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("returns no tenant rows when no tenant is set", async () => {
    const rows = await app.db.select().from(bots);
    expect(rows).toHaveLength(0);
  });

  it("only returns the current tenant's rows", async () => {
    const rowsA = await withTenant(app.db, tenantA, (tx) => tx.select().from(bots));
    expect(rowsA.map((r) => r.name)).toEqual(["Bot A"]);

    const rowsB = await withTenant(app.db, tenantB, (tx) => tx.select().from(bots));
    expect(rowsB.map((r) => r.name)).toEqual(["Bot B"]);
  });

  it("does not leak tenant context to the next transaction", async () => {
    await withTenant(app.db, tenantA, (tx) => tx.select().from(bots));
    const rows = await app.db.select().from(bots);
    expect(rows).toHaveLength(0);
  });

  it("rejects writes for another tenant", async () => {
    await expect(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(bots).values({ tenantId: tenantB, name: "x", pack: "retail" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects child rows pointing at another tenant's bot", async () => {
    await expect(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(businessProfiles).values({ tenantId: tenantA, botId: botB }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(app.db, tenantA, (tx) =>
      tx.update(bots).set({ name: "hacked" }).where(eq(bots.id, botB)).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(app.db, tenantA, (tx) =>
      tx.delete(bots).where(eq(bots.id, botB)).returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  it("resolves a public widget key without tenant context", async () => {
    const keys = await withTenant(app.db, tenantB, (tx) => tx.select().from(botKeys));
    const resolved = await resolveBotKey(app.db, keys[0]!.publicKey);
    expect(resolved).toEqual({ tenantId: tenantB, botId: botB, allowedOrigins: ["https://b.example"] });
    expect(await resolveBotKey(app.db, "pk_test_missing")).toBeNull();
  });

  it("rejects a non-UUID tenant id", async () => {
    await expect(withTenant(app.db, "' or 1=1 --", async () => 1)).rejects.toThrow(/UUID/);
  });
});
