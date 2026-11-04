import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres full-text vector. Written with sql`to_tsvector(...)`, never read back by the app. */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/**
 * pgvector column without fixed dimensions, so different embedding models can coexist; rows record
 * `embedding_model` and searches only compare rows of the same model.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/*
 * Tenancy model
 * -------------
 * - Platform tables (tenants, users, sessions, memberships) are read by the auth/tenancy layer only.
 * - Tenant-owned tables carry `tenant_id` and are protected by Postgres row-level security
 *   (see migrations/0001_rls.sql). The API connects as `traiblazer_app`, which cannot bypass RLS,
 *   and sets `app.tenant_id` per transaction via `withTenant()`.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------------------------
// Platform tables (no RLS)
// ---------------------------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("trial"),
  status: text("status").notNull().default("active"),
  /** Language the business owner reads (inbox translations go into this language). */
  ownerLanguage: text("owner_language").notNull().default("en"),
  /** "default" or "canada" (data residency, Phase 3). */
  dataRegion: text("data_region").notNull().default("default"),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Always stored lower-cased. */
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  uiLanguage: text("ui_language").notNull().default("en"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  ...timestamps,
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the session token; the raw token only lives in the user's cookie. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const memberRoles = ["owner", "admin", "editor", "viewer"] as const;
export type MemberRole = (typeof memberRoles)[number];

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId),
    index("memberships_user_id_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Tenant-owned tables (RLS enforced)
// ---------------------------------------------------------------------------------------------

export interface BotSettings {
  /** Brand color for the chat header and launcher, e.g. "#1f6f5c". */
  color?: string;
  /** Greeting per language code; falls back to a default greeting. */
  greeting?: Record<string, string>;
  /** Suggested first questions per language code. */
  quickReplies?: Record<string, string[]>;
  launcherPosition?: "right" | "left";
}

export const botStatuses = ["draft", "active", "paused"] as const;
export type BotStatus = (typeof botStatuses)[number];

export const botAudiences = ["public", "staff", "members"] as const;
export type BotAudience = (typeof botAudiences)[number];

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Industry pack slug, e.g. "restaurant", and optional variant, e.g. "pub". */
    pack: text("pack").notNull(),
    variant: text("variant"),
    packVersion: integer("pack_version").notNull().default(1),
    audience: text("audience").$type<BotAudience>().notNull().default("public"),
    status: text("status").$type<BotStatus>().notNull().default("draft"),
    /** Enabled answer languages (BCP 47 codes from the language registry). */
    languages: text("languages").array().notNull().default(sql`ARRAY['en']::text[]`),
    defaultLanguage: text("default_language").notNull().default("en"),
    modelProfile: text("model_profile").notNull().default("default"),
    persona: text("persona"),
    /**
     * "Web version": the business's own chat page at /c/<key>, reached by link or QR code — for
     * businesses (e.g. independent contractors) without a website. Off until the owner activates it;
     * embedding on the business's allowed websites works either way.
     */
    hostedPageEnabled: boolean("hosted_page_enabled").notNull().default(false),
    settings: jsonb("settings").$type<BotSettings>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("bots_tenant_id_idx").on(t.tenantId),
    // Lets child tables reference (bot_id, tenant_id) together, so a row can never point at
    // another tenant's bot (plain FK checks ignore row-level security).
    unique("bots_id_tenant_uq").on(t.id, t.tenantId),
  ],
);

export const botKeys = pgTable(
  "bot_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    /** Public widget key (not a secret). Requests are additionally checked against allowed origins. */
    publicKey: text("public_key").notNull().unique(),
    allowedOrigins: text("allowed_origins").array().notNull().default(sql`ARRAY[]::text[]`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bot_keys_tenant_id_idx").on(t.tenantId),
    index("bot_keys_bot_id_idx").on(t.botId),
    foreignKey({
      name: "bot_keys_bot_tenant_fk",
      columns: [t.botId, t.tenantId],
      foreignColumns: [bots.id, bots.tenantId],
    }).onDelete("cascade"),
  ],
);

export type WeeklyHours = Partial<
  Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { open: string; close: string }[]>
>;

export const businessProfiles = pgTable(
  "business_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull().unique(),
    businessName: text("business_name"),
    phone: text("phone"),
    email: text("email"),
    websiteUrl: text("website_url"),
    address: jsonb("address").$type<Record<string, string>>(),
    timezone: text("timezone").notNull().default("America/Toronto"),
    hours: jsonb("hours").$type<WeeklyHours>(),
    staffLanguages: text("staff_languages").array().notNull().default(sql`ARRAY[]::text[]`),
    bookingUrl: text("booking_url"),
    orderingUrl: text("ordering_url"),
    ...timestamps,
  },
  (t) => [
    index("business_profiles_tenant_id_idx").on(t.tenantId),
    foreignKey({
      name: "business_profiles_bot_tenant_fk",
      columns: [t.botId, t.tenantId],
      foreignColumns: [bots.id, bots.tenantId],
    }).onDelete("cascade"),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

/** Tables protected by row-level security. Keep in sync with migrations. */
// ---------------------------------------------------------------------------------------------
// Knowledge (RLS enforced)
// ---------------------------------------------------------------------------------------------

export const sourceTypes = ["website", "text", "qa"] as const;
export type SourceType = (typeof sourceTypes)[number];
export const sourceStatuses = ["pending", "processing", "ready", "failed"] as const;
export type SourceStatus = (typeof sourceStatuses)[number];

export interface SourceSettings {
  /** Website crawl: maximum pages to fetch. */
  maxPages?: number;
}

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    type: text("type").$type<SourceType>().notNull(),
    title: text("title").notNull(),
    /** Website: start URL. */
    url: text("url"),
    /** Text sources: the owner's text. */
    content: text("content"),
    status: text("status").$type<SourceStatus>().notNull().default("pending"),
    error: text("error"),
    settings: jsonb("settings").$type<SourceSettings>().notNull().default({}),
    documentCount: integer("document_count").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("knowledge_sources_bot_idx").on(t.tenantId, t.botId),
    unique("knowledge_sources_id_tenant_uq").on(t.id, t.tenantId),
    foreignKey({
      name: "knowledge_sources_bot_tenant_fk",
      columns: [t.botId, t.tenantId],
      foreignColumns: [bots.id, bots.tenantId],
    }).onDelete("cascade"),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    url: text("url"),
    title: text("title"),
    language: text("language"),
    /** SHA-256 of the extracted text; unchanged pages are not re-chunked on re-sync. */
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    ...timestamps,
  },
  (t) => [
    index("documents_source_idx").on(t.sourceId),
    uniqueIndex("documents_source_url_uq").on(t.sourceId, t.url),
    unique("documents_id_tenant_uq").on(t.id, t.tenantId),
    foreignKey({
      name: "documents_source_tenant_fk",
      columns: [t.sourceId, t.tenantId],
      foreignColumns: [knowledgeSources.id, knowledgeSources.tenantId],
    }).onDelete("cascade"),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    documentId: uuid("document_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    language: text("language"),
    tsv: tsvector("tsv").notNull(),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_bot_idx").on(t.botId),
    index("chunks_document_idx").on(t.documentId),
    index("chunks_tsv_idx").using("gin", t.tsv),
    index("chunks_content_trgm_idx").using("gin", sql`${t.content} gin_trgm_ops`),
    foreignKey({
      name: "chunks_document_tenant_fk",
      columns: [t.documentId, t.tenantId],
      foreignColumns: [documents.id, documents.tenantId],
    }).onDelete("cascade"),
  ],
);

export const qaPairs = pgTable(
  "qa_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    language: text("language").notNull().default("en"),
    enabled: boolean("enabled").notNull().default(true),
    tsv: tsvector("tsv").notNull(),
    ...timestamps,
  },
  (t) => [
    index("qa_pairs_bot_idx").on(t.botId),
    index("qa_pairs_tsv_idx").using("gin", t.tsv),
    index("qa_pairs_question_trgm_idx").using("gin", sql`${t.question} gin_trgm_ops`),
    foreignKey({
      name: "qa_pairs_bot_tenant_fk",
      columns: [t.botId, t.tenantId],
      foreignColumns: [bots.id, bots.tenantId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------------------------
// Conversations & usage (RLS enforced)
// ---------------------------------------------------------------------------------------------

export const channels = ["hosted", "inline", "widget", "playground"] as const;
export type Channel = (typeof channels)[number];

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    /** Random id kept in the visitor's browser; not linked to any personal data. */
    visitorId: text("visitor_id").notNull(),
    language: text("language"),
    /** Page the widget was opened on (embedding site), when known. */
    pageUrl: text("page_url"),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversations_bot_last_idx").on(t.tenantId, t.botId, t.lastMessageAt),
    unique("conversations_id_tenant_uq").on(t.id, t.tenantId),
    foreignKey({
      name: "conversations_bot_tenant_fk",
      columns: [t.botId, t.tenantId],
      foreignColumns: [bots.id, bots.tenantId],
    }).onDelete("cascade"),
  ],
);

export interface Citation {
  title: string | null;
  url: string | null;
  kind: "page" | "text" | "qa";
}

export interface MessageFlags {
  /** The assistant said it couldn't find the answer (knowledge gap). */
  unanswered?: boolean;
  /** The model or the fallback chain declined. */
  refused?: boolean;
  error?: boolean;
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    language: text("language"),
    citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
    flags: jsonb("flags").$type<MessageFlags>().notNull().default({}),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    /** Cost in micro-USD (1e-6 USD). */
    costMicros: bigint("cost_micros", { mode: "number" }),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    foreignKey({
      name: "messages_conversation_tenant_fk",
      columns: [t.conversationId, t.tenantId],
      foreignColumns: [conversations.id, conversations.tenantId],
    }).onDelete("cascade"),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: uuid("bot_id"),
    /** e.g. "llm.chat", "llm.aux", "embedding", "crawl.page" */
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull().default(1),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_events_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Background jobs (platform table, no RLS — workers switch into the job's tenant via withTenant)
// ---------------------------------------------------------------------------------------------

export const jobStatuses = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [index("jobs_ready_idx").on(t.status, t.runAt)],
);

/** Tables protected by row-level security. Keep in sync with migrations. */
export const rlsTables = [
  "bots",
  "bot_keys",
  "business_profiles",
  "audit_logs",
  "knowledge_sources",
  "documents",
  "chunks",
  "qa_pairs",
  "conversations",
  "messages",
  "usage_events",
] as const;
