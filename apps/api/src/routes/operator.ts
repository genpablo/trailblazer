import { memberships, operatorAuditLogs, plans, platformSettings, tenants, users } from "@traiblazer/db";
import {
  createPlanSchema,
  effectiveMonthlyLimit,
  operatorTenantUpdateSchema,
  type PlatformPolicies,
  POLICY_KEYS,
  REPORTING_TIME_ZONE,
  updatePlanSchema,
  updatePoliciesSchema,
} from "@traiblazer/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { periodKey } from "../lib/chat-guard.js";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";

/**
 * Operator console API (Traiblazer staff only): plans, platform policies, businesses and the
 * operator audit log. Non-operators get 404 so the console's existence isn't revealed.
 */
export async function requireOperator(request: FastifyRequest): Promise<void> {
  if (!request.user) throw unauthorized();
  if (!request.user.isOperator) throw notFound("Page");
}

type IdParams = { Params: { id: string } };

interface TenantStatsRow extends Record<string, unknown> {
  tenant_id: string;
  bots: number;
  active_bots: number;
  questions: number;
  blocked: number;
  cost_micros: string;
}

export async function operatorRoutes(app: FastifyInstance, { db, platform }: AppContext) {
  const guard = { preHandler: requireOperator };
  const tz = REPORTING_TIME_ZONE;

  const stats = async () =>
    db.execute<TenantStatsRow>(
      sql`select * from app_operator_tenant_stats(${periodKey()}, (date_trunc('month', now() at time zone ${tz}) at time zone ${tz}))`,
    );

  const log = (
    request: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ) =>
    db
      .insert(operatorAuditLogs)
      .values({ actorUserId: request.user!.id, action, targetType, targetId, metadata });

  // ---- Overview -----------------------------------------------------------------------------

  app.get("/v1/operator/overview", guard, async () => {
    const [rows, tenantRows] = await Promise.all([
      stats(),
      db.select({ plan: tenants.plan, status: tenants.status }).from(tenants),
    ]);
    const sum = (key: keyof TenantStatsRow) => rows.reduce((total, r) => total + Number(r[key]), 0);
    const byPlan: Record<string, number> = {};
    for (const t of tenantRows) byPlan[t.plan] = (byPlan[t.plan] ?? 0) + 1;
    return {
      period: periodKey(),
      businesses: tenantRows.length,
      suspended: tenantRows.filter((t) => t.status === "suspended").length,
      assistants: sum("bots"),
      activeAssistants: sum("active_bots"),
      questions: sum("questions"),
      refused: sum("blocked"),
      costMicros: sum("cost_micros"),
      byPlan,
    };
  });

  // ---- Businesses ---------------------------------------------------------------------------

  app.get<{ Querystring: { q?: string } }>("/v1/operator/tenants", guard, async (request) => {
    const q = (request.query.q ?? "").trim().toLowerCase();
    const [tenantRows, owners, rows] = await Promise.all([
      db.select().from(tenants).orderBy(desc(tenants.createdAt)),
      db
        .select({ tenantId: memberships.tenantId, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.role, "owner")),
      stats(),
    ]);
    const statsById = new Map(rows.map((r) => [r.tenant_id, r]));
    const ownersById = new Map<string, string[]>();
    for (const o of owners) ownersById.set(o.tenantId, [...(ownersById.get(o.tenantId) ?? []), o.email]);
    const planRows = await platform!.plans();

    return {
      tenants: tenantRows
        .map((t) => {
          const s = statsById.get(t.id);
          const plan = planRows.find((p) => p.id === t.plan);
          return {
            id: t.id,
            name: t.name,
            slug: t.slug,
            plan: t.plan,
            status: t.status,
            owners: ownersById.get(t.id) ?? [],
            createdAt: t.createdAt,
            assistants: s?.bots ?? 0,
            activeAssistants: s?.active_bots ?? 0,
            questions: s?.questions ?? 0,
            monthlyLimit: effectiveMonthlyLimit(plan?.monthlyQuestions ?? 0, t.monthlyQuestionLimit),
            refused: s?.blocked ?? 0,
            costMicros: Number(s?.cost_micros ?? 0),
          };
        })
        .filter(
          (t) =>
            !q ||
            t.name.toLowerCase().includes(q) ||
            t.slug.includes(q) ||
            t.owners.some((email) => email.includes(q)),
        ),
    };
  });

  app.patch<IdParams>("/v1/operator/tenants/:id", guard, async (request) => {
    const { id } = request.params;
    if (!isUuid(id)) throw notFound("Business");
    const input = operatorTenantUpdateSchema.parse(request.body);
    if (input.plan) {
      const plan = (await platform!.plans()).find((p) => p.id === input.plan);
      if (!plan?.active) throw badRequest(`Plan "${input.plan}" doesn't exist or is archived`);
    }
    const [before] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!before) throw notFound("Business");
    const [updated] = await db.update(tenants).set(input).where(eq(tenants.id, id)).returning();
    await log(request, "tenant.updated", "tenant", id, {
      from: { plan: before.plan, status: before.status },
      to: input,
    });
    return { tenant: { id: updated!.id, plan: updated!.plan, status: updated!.status } };
  });

  // ---- Plans --------------------------------------------------------------------------------

  app.get("/v1/operator/plans", guard, async () => {
    const counts = await db
      .select({ plan: tenants.plan, count: sql<number>`count(*)::int` })
      .from(tenants)
      .groupBy(tenants.plan);
    const byPlan = new Map(counts.map((c) => [c.plan, c.count]));
    const rows = await db.select().from(plans).orderBy(plans.sortOrder, plans.id);
    return { plans: rows.map((p) => ({ ...p, businesses: byPlan.get(p.id) ?? 0 })) };
  });

  app.post("/v1/operator/plans", guard, async (request, reply) => {
    const input = createPlanSchema.parse(request.body);
    const [existing] = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, input.id)).limit(1);
    if (existing) throw conflict(`Plan "${input.id}" already exists`);
    const [created] = await db.insert(plans).values(input).returning();
    platform!.invalidate();
    await log(request, "plan.created", "plan", input.id, { ...input });
    return reply.code(201).send({ plan: created });
  });

  app.patch<IdParams>("/v1/operator/plans/:id", guard, async (request) => {
    const { id } = request.params;
    const input = updatePlanSchema.parse(request.body);
    if (input.active === false && (await platform!.policies()).defaultPlan === id) {
      throw badRequest("This is the default plan for new businesses. Choose another default first.");
    }
    const [before] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
    if (!before) throw notFound("Plan");
    const [updated] = await db.update(plans).set(input).where(eq(plans.id, id)).returning();
    platform!.invalidate();
    const changed = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]),
    );
    await log(request, "plan.updated", "plan", id, changed);
    return { plan: updated };
  });

  // ---- Policies -----------------------------------------------------------------------------

  app.get("/v1/operator/policies", guard, async () => {
    platform!.invalidate();
    return { policies: await platform!.policies() };
  });

  app.patch("/v1/operator/policies", guard, async (request) => {
    const input = updatePoliciesSchema.parse(request.body);
    if (input.defaultPlan) {
      const plan = (await platform!.plans()).find((p) => p.id === input.defaultPlan);
      if (!plan?.active) throw badRequest(`Plan "${input.defaultPlan}" doesn't exist or is archived`);
    }
    const before = await platform!.policies();
    for (const [field, value] of Object.entries(input) as [keyof PlatformPolicies, unknown][]) {
      await db
        .insert(platformSettings)
        .values({ key: POLICY_KEYS[field], value, updatedBy: request.user!.id })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: { value, updatedBy: request.user!.id, updatedAt: new Date() },
        });
    }
    platform!.invalidate();
    const after = await platform!.policies();
    await log(
      request,
      "policies.updated",
      "policies",
      "platform",
      Object.fromEntries(
        Object.keys(input).map((k) => [
          k,
          { from: before[k as keyof PlatformPolicies], to: after[k as keyof PlatformPolicies] },
        ]),
      ),
    );
    return { policies: after };
  });

  // ---- Audit log ----------------------------------------------------------------------------

  app.get("/v1/operator/audit", guard, async () => {
    const entries = await db
      .select({
        id: operatorAuditLogs.id,
        action: operatorAuditLogs.action,
        targetType: operatorAuditLogs.targetType,
        targetId: operatorAuditLogs.targetId,
        metadata: operatorAuditLogs.metadata,
        createdAt: operatorAuditLogs.createdAt,
        actor: users.email,
      })
      .from(operatorAuditLogs)
      .leftJoin(users, eq(users.id, operatorAuditLogs.actorUserId))
      .orderBy(desc(operatorAuditLogs.createdAt))
      .limit(100);
    return { entries };
  });
}
