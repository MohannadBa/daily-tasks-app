import type { Prisma } from '@dailytasks/database';
import type { AuthUser } from '../auth/auth.types';
import type { Tx } from '../prisma/prisma.service';

/**
 * Append-only administrative audit entry (accounts, departments, documents, break-glass actions).
 * Never put secrets (passwords, tokens) in `metadata`.
 */
export function audit(tx: Tx, actor: Pick<AuthUser, 'id' | 'companyId'>, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  return tx.auditLog.create({
    data: { companyId: actor.companyId, actorId: actor.id, action, entityType, entityId, metadata: metadata as Prisma.InputJsonValue },
  });
}
