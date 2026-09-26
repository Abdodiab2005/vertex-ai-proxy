import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { SystemSetting } from "@gateway/database";
import type { EntityManager, Repository } from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import {
  SETTINGS_DEFINITIONS,
  applySettingsPatch,
  changedSettingKeys,
  cloneSnapshot,
  defaultSnapshot,
  isSettingKey,
  parseSettingsPatch,
  pickSettings,
  writeSetting,
  type SettingKey,
  type SettingsSnapshot,
} from "./settings.definitions.js";

export interface SettingsActor {
  adminUserId: string;
  ipAddress: string | null;
}

export type SettingsClock = () => number;

export const SETTINGS_CLOCK = Symbol("SETTINGS_CLOCK");

// Public requests read settings on every call. The resolved snapshot is cached
// in-process so that read does not hit Postgres each time. There is no
// cross-instance invalidation: after an update, other API processes keep the
// previous snapshot until this TTL elapses, so they converge within 5 seconds.
export const SETTINGS_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  snapshot: SettingsSnapshot;
  loadedAt: number;
  generation: number;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly now: SettingsClock;
  private cached: CacheEntry | null = null;
  private cacheGeneration = 0;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly settings: Repository<SystemSetting>,
    private readonly audit: AuditService,
    @Optional() @Inject(SETTINGS_CLOCK) clock?: SettingsClock,
  ) {
    this.now = clock ?? Date.now;
  }

  async getAll(): Promise<SettingsSnapshot> {
    const cached = this.cached;
    if (cached !== null && this.now() - cached.loadedAt < SETTINGS_CACHE_TTL_MS) {
      return cloneSnapshot(cached.snapshot);
    }

    const generation = this.cacheGeneration;
    const snapshot = await this.loadSnapshot(this.settings);
    if (this.cacheGeneration === generation) {
      this.remember(snapshot);
    }
    return cloneSnapshot(snapshot);
  }

  async get<K extends SettingKey>(key: K): Promise<SettingsSnapshot[K]> {
    const snapshot = await this.getAll();
    return snapshot[key];
  }

  async update(body: unknown, actor: SettingsActor): Promise<SettingsSnapshot> {
    const patch = parseSettingsPatch(body);
    const snapshot = await this.settings.manager.transaction(async (manager) => {
      const current = await this.loadSnapshot(manager.getRepository(SystemSetting));
      const changed = changedSettingKeys(current, patch);
      if (changed.length === 0) {
        return current;
      }

      const next = applySettingsPatch(current, patch);
      await this.writeRows(manager, changed, next, actor.adminUserId);
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED,
          adminUserId: actor.adminUserId,
          entityType: "system_setting",
          entityId: null,
          ipAddress: actor.ipAddress,
          before: pickSettings(current, changed),
          after: pickSettings(next, changed),
        },
        manager,
      );
      return next;
    });

    this.clearCache();
    this.remember(snapshot);
    return cloneSnapshot(snapshot);
  }

  // Tests truncate system_settings directly, which skips update()'s invalidation.
  clearCache(): void {
    this.cacheGeneration += 1;
    this.cached = null;
  }

  private remember(snapshot: SettingsSnapshot): void {
    this.cached = {
      snapshot: cloneSnapshot(snapshot),
      loadedAt: this.now(),
      generation: this.cacheGeneration,
    };
  }

  private async loadSnapshot(repo: Repository<SystemSetting>): Promise<SettingsSnapshot> {
    const rows = await repo.find();
    const snapshot = defaultSnapshot();
    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        continue;
      }
      const parsed = SETTINGS_DEFINITIONS[row.key].schema.safeParse(row.value);
      if (!parsed.success) {
        // A corrupt row must not take the public API down; the default keeps
        // the gateway serving until an admin writes a valid value.
        this.logger.warn(`Ignoring stored setting "${row.key}" because it does not match its schema.`);
        continue;
      }
      writeSetting(snapshot, row.key, parsed.data as SettingsSnapshot[SettingKey]);
    }
    return snapshot;
  }

  private async writeRows(
    manager: EntityManager,
    keys: readonly SettingKey[],
    snapshot: SettingsSnapshot,
    adminUserId: string,
  ): Promise<void> {
    for (const key of keys) {
      // TypeORM persists JavaScript null as SQL NULL, but value is NOT NULL.
      // JSON null is a real jsonb value, so bind the encoded text and cast it.
      await manager.query(
        `INSERT INTO system_settings (key, value, updated_by_admin_id, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by_admin_id = EXCLUDED.updated_by_admin_id,
             updated_at = now()`,
        [key, JSON.stringify(snapshot[key]), adminUserId],
      );
    }
  }
}
