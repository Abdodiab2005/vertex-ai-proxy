import { AuditLog } from "@gateway/database";
import type { EntityManager, Repository } from "typeorm";
import { AuditService } from "./audit.service.js";

describe("AuditService", () => {
  const insert = vi.fn();
  const service = new AuditService({ insert } as unknown as Repository<never>);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one audit row with omitted optional values as null", async () => {
    insert.mockResolvedValue(undefined);

    await expect(
      service.record({
        action: "admin.login.succeeded",
        entityType: "admin_user",
        before: { status: "pending" },
        after: { status: "active" },
      }),
    ).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      action: "admin.login.succeeded",
      adminUserId: null,
      entityType: "admin_user",
      entityId: null,
      ipAddress: null,
      before: { status: "pending" },
      after: { status: "active" },
    });
  });

  it("writes through the caller's EntityManager when one is provided", async () => {
    const managerInsert = vi.fn().mockResolvedValue(undefined);
    const manager = { insert: managerInsert } as unknown as EntityManager;

    await service.record({ action: "admin.upstream.created" }, manager);

    expect(insert).not.toHaveBeenCalled();
    expect(managerInsert).toHaveBeenCalledWith(AuditLog, {
      action: "admin.upstream.created",
      adminUserId: null,
      entityType: null,
      entityId: null,
      ipAddress: null,
      before: null,
      after: null,
    });
  });

  it("propagates persistence errors", async () => {
    const error = new Error("database unavailable");
    insert.mockRejectedValue(error);

    await expect(service.record({ action: "admin.login.failed" })).rejects.toThrow(error);
  });
});
