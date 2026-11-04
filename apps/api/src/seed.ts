/**
 * Local demo data: one owner account, one business, one restaurant assistant.
 * Runs as the owner role (DATABASE_URL). Safe to re-run: skips if the demo user exists.
 */
import { botKeys, bots, businessProfiles, createDb, memberships, tenants, users } from "@traiblazer/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import { newPublicKey, slugify } from "./lib/ids.js";

const DEMO_EMAIL = "demo@traiblazer.local";
const DEMO_PASSWORD = "demo-password-123";

const url = process.env.DATABASE_URL ?? "postgres://traiblazer:traiblazer@localhost:5433/traiblazer";
const { db, close } = createDb(url, { max: 1 });

try {
  const [existing] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing) {
    console.log(`Demo user already exists: ${DEMO_EMAIL}`);
  } else {
    await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: DEMO_EMAIL, name: "Demo Owner", passwordHash: await hashPassword(DEMO_PASSWORD) })
        .returning();
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: "Lakeside Bistro", slug: slugify("Lakeside Bistro") })
        .returning();
      await tx.insert(memberships).values({ tenantId: tenant!.id, userId: user!.id, role: "owner" });
      const [bot] = await tx
        .insert(bots)
        .values({
          tenantId: tenant!.id,
          name: "Lakeside Bistro Assistant",
          pack: "restaurant",
          variant: "casual",
          languages: ["en", "fr", "zh-Hans", "pa"],
          defaultLanguage: "en",
        })
        .returning();
      await tx.insert(businessProfiles).values({
        tenantId: tenant!.id,
        botId: bot!.id,
        businessName: "Lakeside Bistro",
        phone: "+1 807 555 0100",
        websiteUrl: "https://lakeside-bistro.example",
        timezone: "America/Thunder_Bay",
        hours: {
          tue: [{ open: "11:00", close: "21:00" }],
          wed: [{ open: "11:00", close: "21:00" }],
          thu: [{ open: "11:00", close: "21:00" }],
          fri: [{ open: "11:00", close: "22:00" }],
          sat: [{ open: "10:00", close: "22:00" }],
          sun: [{ open: "10:00", close: "20:00" }],
        },
        staffLanguages: ["en", "fr", "pa"],
      });
      await tx.insert(botKeys).values({
        tenantId: tenant!.id,
        botId: bot!.id,
        publicKey: newPublicKey(false),
        allowedOrigins: ["http://localhost:3000"],
      });
    });
    console.log(`Seeded demo data. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  }
} finally {
  await close();
}
