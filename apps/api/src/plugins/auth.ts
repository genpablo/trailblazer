import {
  type Db,
  type MemberRole,
  memberships,
  operatorAuditLogs,
  tenants,
  withTenant,
} from "@traiblazer/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { audit } from "../lib/audit.js";
import { forbidden, notFound, unauthorized } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    /**
     * Set by requireTenantRole for tenant-scoped routes. `support` is true when a Traiblazer super
     * admin is helping a business they don't belong to.
     */
    tenant: { id: string; role: MemberRole; support: boolean } | null;
  }
}

const roleRank: Record<MemberRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** Role a super admin gets in a business they're supporting: can change settings, not ownership. */
export const SUPPORT_ROLE: MemberRole = "admin";

export function hasRole(actual: MemberRole, required: MemberRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

export const isSuperAdmin = (user: SessionUser | null) => user?.platformRole === "super_admin";

/** onRequest hook: resolves the session cookie into request.user (or null). */
export function loadUser(db: Db) {
  return async (request: FastifyRequest) => {
    request.user = null;
    request.tenant = null;
    const token = request.cookies[SESSION_COOKIE];
    if (token) request.user = await getSessionUser(db, token);
  };
}

export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
}

/** preHandler for the operator console. Everyone but super admins gets 404 so it stays hidden. */
export async function requireSuperAdmin(request: FastifyRequest): Promise<void> {
  if (!request.user) throw unauthorized();
  if (!isSuperAdmin(request.user)) throw notFound("Page");
}

/**
 * preHandler for routes under /v1/tenants/:tenantId. Verifies membership and minimum role and sets
 * request.tenant. Non-members get 404 (not 403) so tenant ids can't be probed. Super admins (who
 * can never be members) get support access with the SUPPORT_ROLE; their changes are audited.
 */
export function requireTenantRole(db: Db, minimum: MemberRole) {
  return async (request: FastifyRequest<{ Params: { tenantId: string } }>) => {
    if (!request.user) throw unauthorized();
    const { tenantId } = request.params;
    if (!isUuid(tenantId)) throw notFound("Business");
    if (isSuperAdmin(request.user)) {
      const [exists] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!exists) throw notFound("Business");
      if (!hasRole(SUPPORT_ROLE, minimum)) throw forbidden();
      request.tenant = { id: tenantId, role: SUPPORT_ROLE, support: true };
      return;
    }
    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, request.user.id)))
      .limit(1);
    if (!membership) throw notFound("Business");
    if (!hasRole(membership.role, minimum)) throw forbidden();
    request.tenant = { id: tenantId, role: membership.role, support: false };
  };
}

/**
 * onSend hook: every successful change a super admin makes in a business is recorded in that
 * business's own audit log (so the owner can see it) and in the operator audit log, before the
 * response goes out.
 */
export function auditSupportChanges(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const tenant = request.tenant;
    if (!tenant?.support || !request.user) return payload;
    if (request.method === "GET" || request.method === "HEAD" || reply.statusCode >= 400) return payload;
    const metadata = { method: request.method, route: request.routeOptions.url ?? request.url };
    try {
      await withTenant(db, tenant.id, (tx) =>
        audit(tx, { tenantId: tenant.id, actorUserId: request.user!.id, action: "support.change", metadata }),
      );
      await db.insert(operatorAuditLogs).values({
        actorUserId: request.user.id,
        action: "support.change",
        targetType: "tenant",
        targetId: tenant.id,
        metadata,
      });
    } catch (err) {
      request.log.error({ err }, "failed to record support change");
    }
    return payload;
  };
}
