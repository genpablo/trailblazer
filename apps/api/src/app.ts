import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { HttpError } from "./lib/errors.js";
import { loadUser } from "./plugins/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { catalogRoutes } from "./routes/catalog.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { publicRoutes } from "./routes/public.js";
import { tenantRoutes } from "./routes/tenants.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      ctx.config.NODE_ENV === "test"
        ? false
        : {
            level: ctx.config.LOG_LEVEL,
            redact: ["req.headers.cookie", 'res.headers["set-cookie"]'],
            ...(ctx.config.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
          },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // The chat page sets its own CSP with per-bot frame-ancestors, so X-Frame-Options is off globally.
  await app.register(helmet, { contentSecurityPolicy: false, frameguard: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", enableDraftSpec: true });

  app.decorateRequest("user", null);
  app.decorateRequest("tenant", null);
  app.addHook("onRequest", loadUser(ctx.db));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Invalid request",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  app.get("/health", async () => {
    await ctx.db.execute(sql`select 1`);
    return { ok: true };
  });

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => tenantRoutes(scope, ctx));
  await app.register(async (scope) => botRoutes(scope, ctx));
  await app.register(async (scope) => catalogRoutes(scope));
  await app.register(async (scope) => knowledgeRoutes(scope, ctx));
  await app.register(async (scope) => assetRoutes(scope, ctx));
  await app.register(async (scope) => publicRoutes(scope, ctx));

  return app;
}
