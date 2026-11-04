import { isSupportedLanguage, normalizeLanguageTag } from "@traiblazer/i18n";
import { z } from "zod";

/** Request/response schemas shared by the API and the admin portal. */

export const MIN_PASSWORD_LENGTH = 10;

const languageCode = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const code = normalizeLanguageTag(value);
    if (!code || !isSupportedLanguage(code)) {
      ctx.addIssue({ code: "custom", message: `Unsupported language: ${value}` });
      return z.NEVER;
    }
    return code as string;
  });

const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

export const signupSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  name: z.string().trim().min(1).max(120),
  uiLanguage: languageCode.optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ownerLanguage: languageCode.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

const languagesList = z
  .array(languageCode)
  .min(1)
  .max(30)
  .transform((list) => [...new Set(list)]);

export const createBotSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    pack: z.string().trim().min(1).max(60),
    variant: z.string().trim().min(1).max(60).nullish(),
    languages: languagesList.optional(),
    defaultLanguage: languageCode.optional(),
    allowedOrigins: z.array(httpUrl).max(20).optional(),
  })
  .refine((b) => !b.defaultLanguage || !b.languages || b.languages.includes(b.defaultLanguage), {
    message: "defaultLanguage must be one of languages",
    path: ["defaultLanguage"],
  });
export type CreateBotInput = z.infer<typeof createBotSchema>;

export const updateBotSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    variant: z.string().trim().min(1).max(60).nullable(),
    status: z.enum(["draft", "active", "paused"]),
    languages: languagesList,
    defaultLanguage: languageCode,
    persona: z.string().trim().max(2000).nullable(),
    hostedPageEnabled: z.boolean(),
    settings: z
      .object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1f6f5c"),
        greeting: z.record(z.string(), z.string().trim().max(300)),
        quickReplies: z.record(z.string(), z.array(z.string().trim().min(1).max(120)).max(6)),
        launcherPosition: z.enum(["right", "left"]),
      })
      .partial(),
  })
  .partial();
export type UpdateBotInput = z.infer<typeof updateBotSchema>;

// ---- Knowledge -------------------------------------------------------------------------------

export const createSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("website"),
    url: httpUrl,
    title: z.string().trim().min(1).max(200).optional(),
    maxPages: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("text"),
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(50_000),
  }),
]);
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const qaPairSchema = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(4000),
  language: languageCode.optional(),
});
export type QaPairInput = z.infer<typeof qaPairSchema>;

// ---- Public chat -----------------------------------------------------------------------------

export const publicChatSchema = z.object({
  publicKey: z.string().regex(/^pk_(live|test)_[A-Za-z0-9_-]{10,64}$/),
  conversationId: z.uuid().nullish(),
  visitorId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  message: z.string().trim().min(1).max(2000),
  channel: z.enum(["hosted", "inline", "widget", "playground"]).default("hosted"),
  pageUrl: z.string().max(2000).nullish(),
});
export type PublicChatInput = z.infer<typeof publicChatSchema>;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const dayHours = z.array(z.object({ open: timeOfDay, close: timeOfDay })).max(4);

export const businessProfileSchema = z
  .object({
    businessName: z.string().trim().max(200).nullable(),
    phone: z.string().trim().max(40).nullable(),
    email: z.email().max(254).nullable(),
    websiteUrl: httpUrl.nullable(),
    address: z.record(z.string(), z.string().max(200)).nullable(),
    timezone: z.string().max(64),
    hours: z
      .object({
        mon: dayHours,
        tue: dayHours,
        wed: dayHours,
        thu: dayHours,
        fri: dayHours,
        sat: dayHours,
        sun: dayHours,
      })
      .partial()
      .nullable(),
    staffLanguages: z.array(languageCode).max(30),
    bookingUrl: httpUrl.nullable(),
    orderingUrl: httpUrl.nullable(),
  })
  .partial();
export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

export const addAllowedOriginSchema = z.object({ origin: httpUrl });
