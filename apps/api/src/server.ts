import { fileURLToPath } from "node:url";
import { createDb } from "@traiblazer/db";
import { createEmbeddingsFromEnv, createGatewayFromEnv } from "@traiblazer/llm";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_APP_URL);
const { gateway, offline } = createGatewayFromEnv();
const embeddings = createEmbeddingsFromEnv();
const chatDistDir = process.env.CHAT_DIST_DIR ?? fileURLToPath(new URL("../../chat/dist", import.meta.url));

const app = await buildApp({ db, config, gateway, embeddings, chatDistDir });
if (offline) {
  app.log.warn(
    "No LLM API key configured: chat answers come from the offline test provider (set ANTHROPIC_API_KEY).",
  );
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.API_PORT, host: config.API_HOST });
