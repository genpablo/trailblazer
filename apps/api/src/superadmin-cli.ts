/**
 * Grant or revoke super admin (Traiblazer staff) access to the operator console.
 *
 *   pnpm --filter @traiblazer/api superadmin grant dev@example.com
 *   pnpm --filter @traiblazer/api superadmin revoke dev@example.com
 *   pnpm --filter @traiblazer/api superadmin list
 *
 * Runs as the database owner (DATABASE_URL): there is deliberately no API for this, so a stolen
 * staff session can't create more staff. Staff use dedicated accounts: an account that belongs to a
 * business can't be made a super admin (the database refuses it too).
 */
import { createDb, memberships, users } from "@traiblazer/db";
import { eq, isNotNull, sql } from "drizzle-orm";

const [command, rawEmail] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const url = process.env.DATABASE_URL ?? "postgres://traiblazer:traiblazer@localhost:5433/traiblazer";

if (!command || !["grant", "revoke", "list"].includes(command) || (command !== "list" && !email)) {
  console.error("Usage: superadmin <grant|revoke> <email> | superadmin list");
  process.exit(2);
}

const { db, close } = createDb(url, { max: 1 });
try {
  if (command === "list") {
    const rows = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(isNotNull(users.platformRole))
      .orderBy(users.email);
    if (rows.length === 0) console.log("No super admins.");
    for (const r of rows) console.log(`${r.email}  (${r.name})`);
  } else {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email!))
      .limit(1);
    if (!user) {
      console.error(`No account with email ${email}. Sign up with a dedicated staff account first.`);
      process.exitCode = 1;
    } else if (command === "grant") {
      const [member] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .limit(1);
      if (member) {
        console.error(
          `${email} belongs to a business. Staff need a separate account that isn't part of any business.`,
        );
        process.exitCode = 1;
      } else {
        await db.update(users).set({ platformRole: "super_admin" }).where(eq(users.id, user.id));
        console.log(`${email} is now a super admin.`);
      }
    } else {
      await db.update(users).set({ platformRole: null }).where(eq(users.id, user.id));
      console.log(`${email} is no longer a super admin.`);
    }
  }
} finally {
  await close();
}
