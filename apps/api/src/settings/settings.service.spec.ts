import { BadRequestException } from "@nestjs/common";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { SystemSetting } from "@gateway/database";
import type { Repository } from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import { SETTINGS_CACHE_TTL_MS, SettingsService, type SettingsActor } from "./settings.service.js";

const actor: SettingsActor = { adminUserId: "admin-1", ipAddress: null };

function createHarness(initial: Array<{ key: string; value: unknown }> = []) {
  const stored = new Map(initial.map((row) => [row.key, row.value]));
  const find = vi.fn(async () =>
    [...stored.entries()].map(([key, value]) => ({ key, value })),
  );
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    const key = params[0];
    const encoded = params[1];
    if (typeof key !== "string" || typeof encoded !== "string") {
      throw new Error("settings upsert expected a key and a JSON value");
    }
    stored.set(key, JSON.parse(encoded) as unknown);
    return [];
  });
  const record = vi.fn(async (_event: unknown, _manager?: unknown) => undefined);
  const transaction = vi.fn(
    async (work: (manager: { getRepository: () => { find: typeof find }; query: typeof query }) => Promise<unknown>) =>
      work({
        getRepository: () => ({ find }),
        query,
      }),
  );

  let now = 0;
  const service = new SettingsService(
    { find, manager: { transaction } } as unknown as Repository<SystemSetting>,
    { record } as unknown as AuditService,
    () => now,
  );

  return {
    service,
    find,
    query,
    record,
    stored,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("SettingsService cache", () => {
  it("reuses the resolved snapshot until the TTL and then reads again", async () => {
    const { service, find, advance } = createHarness();

    const first = await service.getAll();
    first["keys.defaultAllowedModels"].push("mutated");
    expect(find).toHaveBeenCalledTimes(1);

    const second = await service.getAll();
    expect(second["gateway.enabled"]).toBe(true);
    expect(second["keys.defaultAllowedModels"]).toEqual([]);
    expect(find).toHaveBeenCalledTimes(1);

    advance(SETTINGS_CACHE_TTL_MS - 1);
    await service.getAll();
    expect(find).toHaveBeenCalledTimes(1);

    advance(1);
    await service.getAll();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("serves an update immediately and ignores a direct table change until the TTL", async () => {
    const { service, find, query, record, stored, advance } = createHarness();

    await service.getAll();
    expect(find).toHaveBeenCalledTimes(1);

    const updated = await service.update({ "gateway.killSwitch": true }, actor);
    expect(updated["gateway.killSwitch"]).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(stored.get("gateway.killSwitch")).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      action: ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED,
      adminUserId: "admin-1",
      entityType: "system_setting",
      entityId: null,
      before: { "gateway.killSwitch": false },
      after: { "gateway.killSwitch": true },
    });
    expect(record.mock.calls[0]?.[1]).toBeDefined();

    const cached = await service.getAll();
    expect(cached["gateway.killSwitch"]).toBe(true);
    expect(find).toHaveBeenCalledTimes(2);

    stored.set("gateway.killSwitch", false);
    advance(SETTINGS_CACHE_TTL_MS - 1);
    expect((await service.getAll())["gateway.killSwitch"]).toBe(true);

    advance(1);
    expect((await service.getAll())["gateway.killSwitch"]).toBe(false);
  });

  it("does not write or audit a value that is already current", async () => {
    const { service, query, record } = createHarness();

    await service.update({ "gateway.enabled": true, "spend.safetyReserve": "0" }, actor);

    expect(query).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("falls back to the default when a stored value fails its schema", async () => {
    const { service } = createHarness([{ key: "gateway.enabled", value: "nope" }]);

    await expect(service.get("gateway.enabled")).resolves.toBe(true);
  });

  it("rejects an unknown key and a bad value by name", async () => {
    const { service, query } = createHarness();

    const unknown = await service.update({ "not.a.setting": true }, actor).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(BadRequestException);
    if (unknown instanceof BadRequestException) {
      expect(unknown.getResponse()).toMatchObject({
        message: ["not.a.setting: Unknown setting"],
      });
    }

    const invalid = await service
      .update({ "timeouts.requestMs": 50, "billing.currency": "usd" }, actor)
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(BadRequestException);
    if (invalid instanceof BadRequestException) {
      const response = invalid.getResponse();
      expect(response).toMatchObject({ statusCode: 400 });
      if (typeof response === "object" && response !== null && "message" in response) {
        const message = response.message;
        expect(Array.isArray(message)).toBe(true);
        if (Array.isArray(message)) {
          expect(message.some((line) => typeof line === "string" && line.startsWith("timeouts.requestMs:"))).toBe(
            true,
          );
          expect(message.some((line) => typeof line === "string" && line.startsWith("billing.currency:"))).toBe(
            true,
          );
        }
      }
    }

    expect(query).not.toHaveBeenCalled();
  });
});
