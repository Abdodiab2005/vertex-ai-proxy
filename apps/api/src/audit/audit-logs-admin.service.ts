import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLog } from "@gateway/database";
import { AdminUser } from "@gateway/database";
import { redactSecrets } from "./redactor.js";
import type { ListAuditLogsQueryDto, AuditEntryView, ListAuditLogsResponse, AuditActionsResponse } from "./audit-logs.schemas.js";

@Injectable()
export class AuditLogsAdminService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(AdminUser)
    private readonly adminUsers: Repository<AdminUser>,
  ) {}

  async listAuditLogs(query: ListAuditLogsQueryDto): Promise<ListAuditLogsResponse> {
    const limit = query.limit;
    const qb = this.auditLogs
      .createQueryBuilder("auditLog")
      .leftJoin(AdminUser, "adminUser", "adminUser.id = auditLog.admin_user_id")
      .addSelect("adminUser.email", "adminEmail")
      .orderBy("auditLog.createdAt", "DESC")
      .addOrderBy("auditLog.id", "DESC")
      .take(limit + 1); // Take one extra to detect if there's a next page

    if (query.action) {
      qb.andWhere("auditLog.action = :action", { action: query.action });
    }

    if (query.entityType) {
      qb.andWhere("auditLog.entity_type = :entityType", { entityType: query.entityType });
    }

    if (query.entityId) {
      qb.andWhere("auditLog.entity_id = :entityId", { entityId: query.entityId });
    }

    if (query.adminUserId) {
      qb.andWhere("auditLog.admin_user_id = :adminUserId", { adminUserId: query.adminUserId });
    }

    if (query.from) {
      const fromDate = new Date(query.from);
      qb.andWhere("auditLog.created_at >= :from", { from: fromDate });
    }

    if (query.to) {
      const toDate = new Date(query.to);
      qb.andWhere("auditLog.created_at < :to", { to: toDate });
    }

    if (query.before) {
      const decoded = this.decodeCursor(query.before);
      if (!decoded) {
        throw new Error("Invalid cursor");
      }
      // Keyset pagination: (createdAt, id) < (cursorCreatedAt, cursorId)
      // Since we order by createdAt DESC, id DESC, we need:
      // createdAt < cursorCreatedAt OR (createdAt = cursorCreatedAt AND id < cursorId)
      qb.andWhere(
        "(auditLog.created_at < :cursorCreatedAt OR (auditLog.created_at = :cursorCreatedAt AND auditLog.id < :cursorId))",
        { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
      );
    }

    const rows = await qb.getRawAndEntities();

    const hasMore = rows.entities.length > limit;
    const entities = hasMore ? rows.entities.slice(0, limit) : rows.entities;
    const raws = hasMore ? rows.raw.slice(0, limit) : rows.raw;

    const mappedEntries: AuditEntryView[] = entities.map((row, index) => ({
      id: row.id,
      action: row.action,
      adminUserId: row.adminUserId,
      adminEmail: raws[index]?.adminEmail ?? null,
      entityType: row.entityType,
      entityId: row.entityId,
      ipAddress: row.ipAddress,
      before: row.before ? redactSecrets(row.before) : null,
      after: row.after ? redactSecrets(row.after) : null,
      createdAt: row.createdAt.toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore) {
      const lastEntry = entities[entities.length - 1];
      nextCursor = this.encodeCursor(lastEntry.createdAt, lastEntry.id);
    }

    return { entries: mappedEntries, nextCursor };
  }

  async getDistinctActions(): Promise<AuditActionsResponse> {
    const qb = this.auditLogs
      .createQueryBuilder("auditLog")
      .select("DISTINCT auditLog.action", "action")
      .orderBy("auditLog.action", "ASC");
    const rows = await qb.getRawMany();
    return { actions: rows.map((r) => r.action) };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    const iso = createdAt.toISOString();
    const payload = `${iso}|${id}`;
    return Buffer.from(payload, "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const [iso, id] = decoded.split("|");
      if (!iso || !id) return null;
      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime())) return null;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return null;
      }
      return { createdAt, id };
    } catch {
      return null;
    }
  }
}