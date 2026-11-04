import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  /** Application role connection (RLS applies). */
  DATABASE_APP_URL: z.string().default("postgres://traiblazer_app:traiblazer_app@localhost:5433/traiblazer"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Max sign-up/sign-in attempts per IP per minute. */
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.string().default("info"),
  /** Public origin of this service: chat page links, widget script and same-origin checks. */
  PUBLIC_URL: z.url().default("http://localhost:4000"),
  /** Admin portal origin; allowed to frame the chat page (playground). */
  ADMIN_ORIGIN: z.url().default("http://localhost:3000"),
  /** Max chat messages per IP per minute on the public chat endpoint. */
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
