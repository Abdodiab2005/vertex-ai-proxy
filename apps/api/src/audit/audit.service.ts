import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { AuditLog } from "@gateway/database";
import type { EntityManager, QueryDeepPartialEntity, Repository } from "typeorm";

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  // Callers must never pass secrets (passwords, tokens, hashes) in before/after.
  async record(event: {
    action: string;
    adminUserId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    ipAddress?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  }, manager?: EntityManager): Promise<void> {
    const row = {
      action: event.action,
      adminUserId: event.adminUserId ?? null,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      ipAddress: event.ipAddress ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
    } as QueryDeepPartialEntity<AuditLog>;

    // Pass the caller's manager so the audit row commits or rolls back with the
    // change it describes. The repository insert runs on a different connection.
    if (manager === undefined) {
      await this.auditLogs.insert(row);
      return;
    }
    await manager.insert(AuditLog, row);
  }
}
