import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Folder with SQL migrations, resolved relative to this file (works from src/ and dist/). */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies all pending migrations. Must run as the owner role (DATABASE_URL), not the app role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
