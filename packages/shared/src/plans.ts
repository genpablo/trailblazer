import { z } from "zod";

/**
 * Plan allowances (PLAN.md §16). Monthly questions cap AI cost per business; the per-minute and
 * concurrency limits keep one busy business from slowing down everyone else ("noisy neighbours").
 */
export interface PlanLimits {
  name: Record<"en" | "fr", string>;
  /** Visitor questions answered per calendar month. */
  monthlyQuestions: number;
  /** Answers being generated at the same time for this business. */
  concurrent: number;
  /** Questions per minute for this business (all visitors together). */
  perMinute: number;
}

export const PLANS = {
  trial: {
    name: { en: "Free trial", fr: "Essai gratuit" },
    monthlyQuestions: 100,
    concurrent: 3,
    perMinute: 20,
  },
  local: { name: { en: "Local", fr: "Local" }, monthlyQuestions: 1000, concurrent: 5, perMinute: 40 },
  local_plus: {
    name: { en: "Local Plus", fr: "Local Plus" },
    monthlyQuestions: 3000,
    concurrent: 8,
    perMinute: 60,
  },
  professional: {
    name: { en: "Professional", fr: "Professionnel" },
    monthlyQuestions: 5000,
    concurrent: 10,
    perMinute: 90,
  },
  business: {
    name: { en: "Business", fr: "Affaires" },
    monthlyQuestions: 20000,
    concurrent: 25,
    perMinute: 200,
  },
} as const satisfies Record<string, PlanLimits>;

export type PlanId = keyof typeof PLANS;

export function planLimits(plan: string): PlanLimits {
  return (PLANS as Record<string, PlanLimits>)[plan] ?? PLANS.trial;
}

/** Default questions one visitor may ask per day (all assistants of the business). */
export const DEFAULT_VISITOR_DAILY_LIMIT = 30;
/** Questions per conversation before the visitor is asked to start a new one. */
export const MAX_CONVERSATION_QUESTIONS = 40;
/** Monthly periods and daily usage are counted in this time zone. */
export const REPORTING_TIME_ZONE = "America/Toronto";

/** The monthly limit in force: the owner's own cap, never above the plan's allowance. */
export function effectiveMonthlyLimit(plan: string, ownerLimit: number | null | undefined): number {
  const planMax = planLimits(plan).monthlyQuestions;
  return ownerLimit ? Math.min(ownerLimit, planMax) : planMax;
}

export const updateLimitsSchema = z
  .object({
    /** Null = use the plan's allowance. */
    monthlyQuestionLimit: z.number().int().min(1).max(1_000_000).nullable(),
    /** Null = default per-visitor limit. */
    visitorDailyLimit: z.number().int().min(1).max(500).nullable(),
  })
  .partial();
export type UpdateLimitsInput = z.infer<typeof updateLimitsSchema>;
