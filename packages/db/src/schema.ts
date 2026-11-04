import { sql } from "drizzle-orm";
import {
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
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
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
export const rlsTables = ["bots", "bot_keys", "business_profiles", "audit_logs"] as const;
