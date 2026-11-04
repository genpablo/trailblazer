import { runMigrations } from "./migrator.js";

const url = process.env.DATABASE_URL ?? "postgres://traiblazer:traiblazer@localhost:5433/traiblazer";

await runMigrations(url);
console.log(`Migrations applied to ${new URL(url).pathname.slice(1)}`);
