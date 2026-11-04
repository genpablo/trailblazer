import { auditLogs, memberships, tenants, users, withTenant } from "@traiblazer/db";
import { createTenantSchema } from "@traiblazer/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { audit } from "../lib/audit.js";
import { notFound } from "../lib/errors.js";
import { slugify } from "../lib/ids.js";
import { requireTenantRole, requireUser } from "../plugins/auth.js";

type TenantParams = { Params: { tenantId: string } };

export async function tenantRoutes(app: FastifyInstance, { db, platform }: AppContext) {
  app.get("/v1/tenants", { preHandler: requireUser }, async (request) => {
    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.plan,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.userId, request.user!.id))
      .orderBy(tenants.name);
    return { tenants: rows };
  });

  app.post("/v1/tenants", { preHandler: requireUser }, async (request, reply) => {
    const input = createTenantSchema.parse(request.body);
    const user = request.user!;
    // New businesses start on the operators' default plan (if it is still offered).
    const [policies, allPlans] = await Promise.all([platform!.policies(), platform!.plans()]);
    const plan = allPlans.find((p) => p.id === policies.defaultPlan && p.active)?.id ?? "trial";

    const tenant = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tenants)
        .values({
          name: input.name,
          slug: slugify(input.name),
          plan,
          ownerLanguage: input.ownerLanguage ?? user.uiLanguage,
        })
        .returning();
      await tx.insert(memberships).values({ tenantId: created!.id, userId: user.id, role: "owner" });
      // Audit log is tenant-scoped (RLS): set the tenant context for the rest of this transaction.
      await tx.execute(sql`select set_config('app.tenant_id', ${created!.id}, true)`);
      await audit(tx, { tenantId: created!.id, actorUserId: user.id, action: "tenant.created" });
      return created!;
    });

    return reply.code(201).send({ tenant: { ...tenant, role: "owner" } });
  });

  app.get<TenantParams>(
    "/v1/tenants/:tenantId",
    { preHandler: requireTenantRole(db, "viewer") },
    async (request) => {
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, request.tenant!.id)).limit(1);
      if (!tenant) throw notFound("Business");
      return { tenant: { ...tenant, role: request.tenant!.role } };
    },
  );

  app.get<TenantParams>(
    "/v1/tenants/:tenantId/members",
    { preHandler: requireTenantRole(db, "viewer") },
    async (request) => {
      const members = await db
        .select({
          userId: users.id,
          name: users.name,
          email: users.email,
          role: memberships.role,
          since: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, request.tenant!.id))
        .orderBy(users.name);
      return { members };
    },
  );

  app.get<TenantParams>(
    "/v1/tenants/:tenantId/audit-logs",
    { preHandler: requireTenantRole(db, "admin") },
    async (request) => {
      const entries = await withTenant(db, request.tenant!.id, (tx) =>
        tx.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100),
      );
      return { entries };
    },
  );
}
