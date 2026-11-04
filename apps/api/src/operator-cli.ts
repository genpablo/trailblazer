/**
 * Grant or revoke operator-console access (Traiblazer staff only).
 *
 *   pnpm --filter @traiblazer/api operator grant someone@example.com
 *   pnpm --filter @traiblazer/api operator revoke someone@example.com
 *   pnpm --filter @traiblazer/api operator list
 *
 * Runs as the database owner (DATABASE_URL): there is deliberately no API for this, so a
 * compromised operator session can't create more operators.
 */
import { createDb, users } from "@traiblazer/db";
import { eq, sql } from "drizzle-orm";

const [command, rawEmail] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const url = process.env.DATABASE_URL ?? "postgres://traiblazer:traiblazer@localhost:5433/traiblazer";

if (!command || !["grant", "revoke", "list"].includes(command) || (command !== "list" && !email)) {
  console.error("Usage: operator <grant|revoke> <email> | operator list");
  process.exit(2);
}

const { db, close } = createDb(url, { max: 1 });
try {
  if (command === "list") {
    const rows = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.isOperator, true))
      .orderBy(users.email);
    if (rows.length === 0) console.log("No operators.");
    for (const r of rows) console.log(`${r.email}  (${r.name})`);
  } else {
    const updated = await db
      .update(users)
      .set({ isOperator: command === "grant" })
      .where(eq(sql`lower(${users.email})`, email!))
      .returning({ email: users.email });
    if (updated.length === 0) {
      console.error(`No account with email ${email}. They need to sign up first.`);
      process.exitCode = 1;
    } else {
      console.log(
        command === "grant" ? `${email} is now an operator.` : `${email} is no longer an operator.`,
      );
    }
  }
} finally {
  await close();
}
