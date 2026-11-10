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
  /**
   * Overrides for operator policies (set in the operator console), mainly for tests and load tests:
   * chat messages per IP per minute, and questions per conversation.
   */
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().optional(),
  CONVERSATION_MAX_QUESTIONS: z.coerce.number().int().positive().optional(),
  /** How long plans and policies are cached per API server. */
  PLATFORM_CACHE_SECONDS: z.coerce.number().int().min(0).default(30),
  /**
   * Which proxies may set the visitor's address through X-Forwarded-For (per-IP rate limits depend
   * on it). Trusting every sender would let anyone pick their own address, so the default only
   * trusts proxies on this machine (the admin portal's /api proxy, a local nginx). Set it to the
   * addresses or networks of your load balancer ("10.0.0.0/8, 172.16.0.0/12"), to the number of
   * proxy hops ("1"), or to "false" when the API is reached directly.
   */
  TRUST_PROXY: z
    .string()
    .default("loopback")
    .transform((value): boolean | number | string[] => {
      const v = value.trim();
      if (v === "" || v === "false") return false;
      if (/^\d+$/.test(v)) return Number(v);
      return v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }),
  /** Shared rate limits and counters across API servers. Without it, limits are per server. */
  REDIS_URL: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
