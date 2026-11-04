import { auditLogs, type Tx } from "@traiblazer/db";

/** Writes an audit entry. Must run inside a tenant-scoped transaction (withTenant). */
export async function audit(
  tx: Tx,
  entry: {
    tenantId: string;
    actorUserId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
  });
}
