import type { Db } from "@traiblazer/db";
import type { EmbeddingProvider, LLMGateway } from "@traiblazer/llm";
import type { AppConfig } from "./config.js";

export interface AppContext {
  db: Db;
  config: AppConfig;
  gateway: LLMGateway;
  embeddings?: EmbeddingProvider | null;
  /** Directory with the built chat page and widget (apps/chat/dist). */
  chatDistDir?: string;
}
