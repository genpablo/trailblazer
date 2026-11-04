import { readFile } from "node:fs/promises";
import path from "node:path";
import { runChat } from "@traiblazer/core";
import {
  type BotSettings,
  bots,
  businessProfiles,
  conversations,
  messages,
  resolveBotKey,
  withTenant,
} from "@traiblazer/db";
import { getLanguage } from "@traiblazer/i18n";
import { getPackGuidance } from "@traiblazer/industry-packs";
import { publicChatSchema } from "@traiblazer/shared";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError, notFound } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";

const KEY_RE = /^pk_(live|test)_[A-Za-z0-9_-]{10,64}$/;

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Shown when a link/QR code points to a chat that is paused, unknown, or whose web version is off. */
const UNAVAILABLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Chat unavailable</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;color:#555;text-align:center}</style></head><body><div><p>This chat isn't available right now.</p><p lang="fr">Ce clavardage n'est pas disponible pour le moment.</p></div></body></html>`;

/**
 * Public, unauthenticated surface used by visitors:
 *   GET  /c/:key                     chat page (hosted link, iframe, widget panel)
 *   GET  /widget.js                  floating-widget loader for customer websites
 *   GET  /chat-assets/assets/:file   chat page assets
 *   GET  /v1/public/bots/:key        chat configuration (branding, languages, greeting)
 *   POST /v1/public/chat             send a message; answer streams back as server-sent events
 *   GET  /v1/public/conversations/:id?key&visitorId   restore a visitor's conversation
 */
export async function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;
  const publicOrigin = new URL(config.PUBLIC_URL).origin;
  const adminOrigin = new URL(config.ADMIN_ORIGIN).origin;
  const distDir = ctx.chatDistDir;

  async function loadBot(publicKey: string) {
    if (!KEY_RE.test(publicKey)) return null;
    const resolved = await resolveBotKey(db, publicKey);
    if (!resolved) return null;
    return withTenant(db, resolved.tenantId, async (tx) => {
      const [bot] = await tx.select().from(bots).where(eq(bots.id, resolved.botId)).limit(1);
      if (!bot) return null;
      const [profile] = await tx
        .select()
        .from(businessProfiles)
        .where(eq(businessProfiles.botId, bot.id))
        .limit(1);
      return { ...resolved, bot, profile: profile ?? null };
    });
  }

  // ---- Chat page ----------------------------------------------------------------------------

  app.get<{ Params: { key: string } }>("/c/:key", async (request, reply) => {
    const found = await loadBot(request.params.key);
    reply.header("cache-control", "no-store").header("referrer-policy", "strict-origin-when-cross-origin");
    if (!found || found.bot.status === "paused") {
      return reply.code(404).type("text/html; charset=utf-8").send(UNAVAILABLE_PAGE);
    }

    // Top-level visits (the shareable link) can be switched off; iframes on allowed sites still work.
    const dest = request.headers["sec-fetch-dest"];
    if (dest === "document" && !found.bot.hostedPageEnabled) {
      return reply.code(404).type("text/html; charset=utf-8").send(UNAVAILABLE_PAGE);
    }

    if (!distDir) throw new HttpError(503, "unavailable", "Chat page is not built");
    const html = await readFile(path.join(distDir, "index.html"), "utf8").catch(() => null);
    if (!html) throw new HttpError(503, "unavailable", "Chat page is not built (run pnpm build)");

    const ancestors = ["'self'", adminOrigin, ...found.allowedOrigins].join(" ");
    reply.header(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        `frame-ancestors ${ancestors}`,
      ].join("; "),
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/widget.js", async (_request, reply) => {
    if (!distDir) throw notFound("Widget");
    const js = await readFile(path.join(distDir, "widget.js"), "utf8").catch(() => null);
    if (!js) throw notFound("Widget");
    return reply
      .type("text/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .header("cross-origin-resource-policy", "cross-origin")
      .header("access-control-allow-origin", "*")
      .send(js);
  });

  app.get<{ Params: { file: string } }>("/chat-assets/assets/:file", async (request, reply) => {
    const { file } = request.params;
    const type = ASSET_TYPES[path.extname(file)];
    if (!distDir || !/^[A-Za-z0-9._-]+$/.test(file) || !type) throw notFound("Asset");
    const body = await readFile(path.join(distDir, "assets", file)).catch(() => null);
    if (!body) throw notFound("Asset");
    return reply.type(type).header("cache-control", "public, max-age=31536000, immutable").send(body);
  });

  // ---- Chat API -----------------------------------------------------------------------------

  app.get<{ Params: { key: string } }>("/v1/public/bots/:key", async (request) => {
    const found = await loadBot(request.params.key);
    if (!found || found.bot.status === "paused") throw notFound("Assistant");
    const { bot, profile } = found;
    const settings: BotSettings = bot.settings ?? {};
    const guidance = getPackGuidance(bot.pack, bot.variant);
    return {
      bot: {
        name: bot.name,
        businessName: profile?.businessName ?? bot.name,
        color: settings.color ?? null,
        launcherPosition: settings.launcherPosition ?? "right",
        defaultLanguage: bot.defaultLanguage,
        languages: bot.languages.map((code) => {
          const lang = getLanguage(code);
          return { code, nativeName: lang?.nativeName ?? code, dir: lang?.dir ?? "ltr" };
        }),
        greeting: settings.greeting ?? {},
        quickReplies: { ...guidance.quickReplies, ...(settings.quickReplies ?? {}) },
        poweredBy: true,
      },
    };
  });

  const assertSameOrigin = (origin: string | undefined) => {
    // The chat page and this API share an origin; browsers always send Origin on POST.
    if (origin && origin !== publicOrigin)
      throw new HttpError(403, "forbidden_origin", "Cross-origin requests are not allowed");
  };

  app.post(
    "/v1/public/chat",
    { config: { rateLimit: { max: config.CHAT_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } } },
    async (request, reply: FastifyReply) => {
      assertSameOrigin(request.headers.origin);
      const input = publicChatSchema.parse(request.body);
      const found = await loadBot(input.publicKey);
      if (!found || found.bot.status === "paused") throw notFound("Assistant");

      const controller = new AbortController();
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      });
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      try {
        for await (const event of runChat(
          {
            db,
            gateway: ctx.gateway,
            embeddings: ctx.embeddings,
            log: (msg, data) => request.log.error(data, msg),
          },
          {
            tenantId: found.tenantId,
            botId: found.botId,
            conversationId: input.conversationId ?? null,
            visitorId: input.visitorId,
            channel: input.channel,
            message: input.message,
            pageUrl: input.pageUrl ?? null,
            signal: controller.signal,
          },
        )) {
          if (controller.signal.aborted) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        request.log.error(error, "chat stream failed");
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({ type: "error", code: "failed", message: "Something went wrong" })}\n\n`,
          );
        }
      } finally {
        res.end();
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { key?: string; visitorId?: string } }>(
    "/v1/public/conversations/:id",
    async (request) => {
      const { id } = request.params;
      const { key = "", visitorId = "" } = request.query;
      if (!isUuid(id) || !visitorId) throw notFound("Conversation");
      const found = await loadBot(key);
      if (!found) throw notFound("Conversation");
      const rows = await withTenant(db, found.tenantId, async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.botId, found.botId),
              eq(conversations.visitorId, visitorId),
            ),
          )
          .limit(1);
        if (!conversation) return null;
        return tx
          .select({ role: messages.role, content: messages.content, citations: messages.citations })
          .from(messages)
          .where(eq(messages.conversationId, id))
          .orderBy(asc(messages.createdAt))
          .limit(100);
      });
      if (!rows) throw notFound("Conversation");
      return { messages: rows };
    },
  );
}
