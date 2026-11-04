import { type Db, type MemberRole, memberships } from "@traiblazer/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { forbidden, notFound, unauthorized } from "../lib/errors.js";
import { isUuid } from "../lib/ids.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    /** Set by requireTenantRole for tenant-scoped routes. */
    tenant: { id: string; role: MemberRole } | null;
  }
}

const roleRank: Record<MemberRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function hasRole(actual: MemberRole, required: MemberRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

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

/**
 * preHandler for routes under /v1/tenants/:tenantId. Verifies membership and minimum role and sets
 * request.tenant. Non-members get 404 (not 403) so tenant ids can't be probed.
 */
export function requireTenantRole(db: Db, minimum: MemberRole) {
  return async (request: FastifyRequest<{ Params: { tenantId: string } }>) => {
    if (!request.user) throw unauthorized();
    const { tenantId } = request.params;
    if (!isUuid(tenantId)) throw notFound("Business");
    const [membership] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, request.user.id)))
      .limit(1);
    if (!membership) throw notFound("Business");
    if (!hasRole(membership.role, minimum)) throw forbidden();
    request.tenant = { id: tenantId, role: membership.role };
  };
}
