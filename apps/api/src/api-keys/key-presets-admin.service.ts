import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { KeyPreset } from "@gateway/database";
import { QueryFailedError, Repository } from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import type { CreateKeyPresetDto, UpdateKeyPresetDto } from "./key-presets.schemas.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_CONFLICT = "A key preset with this name already exists.";

export interface KeyPresetView {
  id: string;
  name: string;
  description: string | null;
  allowedModels: string[];
  blockedModels: string[];
  allowedEndpoints: string[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxConcurrentRequests: number | null;
  initialCredit: string | null;
  lifetimeDays: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class KeyPresetsAdminService {
  constructor(
    @InjectRepository(KeyPreset)
    private readonly presets: Repository<KeyPreset>,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<KeyPresetView[]> {
    const rows = await this.presets.find({ order: { name: "ASC" } });
    return rows.map((row) => toKeyPresetView(row));
  }

  async get(id: string): Promise<KeyPresetView> {
    return toKeyPresetView(await this.requirePreset(id));
  }

  async create(
    adminUserId: string,
    dto: CreateKeyPresetDto,
    ipAddress: string | null,
  ): Promise<KeyPresetView> {
    const preset = this.presets.create({
      name: dto.name,
      description: dto.description ?? null,
      allowedModels: dto.allowedModels ?? [],
      blockedModels: dto.blockedModels ?? [],
      allowedEndpoints: dto.allowedEndpoints ?? [],
      requestsPerMinute: dto.requestsPerMinute ?? null,
      requestsPerDay: dto.requestsPerDay ?? null,
      tokensPerMinute: dto.tokensPerMinute ?? null,
      tokensPerDay: dto.tokensPerDay ?? null,
      tokensPerMonth: dto.tokensPerMonth ?? null,
      maxConcurrentRequests: dto.maxConcurrentRequests ?? null,
      initialCredit: dto.initialCredit ?? null,
      lifetimeDays: dto.lifetimeDays ?? null,
      tags: dto.tags ?? [],
    });

    const saved = await this.save(preset);
    const view = toKeyPresetView(saved);
    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.KEY_PRESET_CREATED,
      adminUserId,
      entityType: "key_preset",
      entityId: saved.id,
      ipAddress,
      after: viewAsRecord(view),
    });
    return view;
  }

  async update(
    adminUserId: string,
    id: string,
    dto: UpdateKeyPresetDto,
    ipAddress: string | null,
  ): Promise<KeyPresetView> {
    const preset = await this.requirePreset(id);
    const before = toKeyPresetView(preset);
    assignPresetPatch(preset, dto);
    const saved = await this.save(preset);
    const after = toKeyPresetView(saved);
    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.KEY_PRESET_UPDATED,
      adminUserId,
      entityType: "key_preset",
      entityId: saved.id,
      ipAddress,
      before: viewAsRecord(before),
      after: viewAsRecord(after),
    });
    return after;
  }

  async delete(adminUserId: string, id: string, ipAddress: string | null): Promise<void> {
    const preset = await this.requirePreset(id);
    const before = toKeyPresetView(preset);
    await this.presets.delete(preset.id);
    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.KEY_PRESET_DELETED,
      adminUserId,
      entityType: "key_preset",
      entityId: preset.id,
      ipAddress,
      before: viewAsRecord(before),
    });
  }

  private async requirePreset(id: string): Promise<KeyPreset> {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException("Key preset not found.");
    }
    const preset = await this.presets.findOne({ where: { id } });
    if (preset === null) {
      throw new NotFoundException("Key preset not found.");
    }
    return preset;
  }

  private async save(preset: KeyPreset): Promise<KeyPreset> {
    try {
      return await this.presets.save(preset);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(NAME_CONFLICT);
      }
      throw error;
    }
  }
}

export function toKeyPresetView(preset: KeyPreset): KeyPresetView {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    allowedModels: [...preset.allowedModels],
    blockedModels: [...preset.blockedModels],
    allowedEndpoints: [...preset.allowedEndpoints],
    requestsPerMinute: preset.requestsPerMinute,
    requestsPerDay: preset.requestsPerDay,
    tokensPerMinute: preset.tokensPerMinute,
    tokensPerDay: preset.tokensPerDay,
    tokensPerMonth: preset.tokensPerMonth,
    maxConcurrentRequests: preset.maxConcurrentRequests,
    initialCredit: preset.initialCredit === null ? null : String(preset.initialCredit),
    lifetimeDays: preset.lifetimeDays,
    tags: [...preset.tags],
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

function assignPresetPatch(preset: KeyPreset, dto: UpdateKeyPresetDto): void {
  if (dto.name !== undefined) preset.name = dto.name;
  if (dto.description !== undefined) preset.description = dto.description;
  if (dto.allowedModels !== undefined) preset.allowedModels = dto.allowedModels;
  if (dto.blockedModels !== undefined) preset.blockedModels = dto.blockedModels;
  if (dto.allowedEndpoints !== undefined) preset.allowedEndpoints = dto.allowedEndpoints;
  if (dto.requestsPerMinute !== undefined) preset.requestsPerMinute = dto.requestsPerMinute;
  if (dto.requestsPerDay !== undefined) preset.requestsPerDay = dto.requestsPerDay;
  if (dto.tokensPerMinute !== undefined) preset.tokensPerMinute = dto.tokensPerMinute;
  if (dto.tokensPerDay !== undefined) preset.tokensPerDay = dto.tokensPerDay;
  if (dto.tokensPerMonth !== undefined) preset.tokensPerMonth = dto.tokensPerMonth;
  if (dto.maxConcurrentRequests !== undefined) preset.maxConcurrentRequests = dto.maxConcurrentRequests;
  if (dto.initialCredit !== undefined) preset.initialCredit = dto.initialCredit;
  if (dto.lifetimeDays !== undefined) preset.lifetimeDays = dto.lifetimeDays;
  if (dto.tags !== undefined) preset.tags = dto.tags;
}

function viewAsRecord(view: KeyPresetView): Record<string, unknown> {
  return { ...view };
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError: unknown = error.driverError;
  if (typeof driverError !== "object" || driverError === null || !("code" in driverError)) {
    return false;
  }
  return driverError.code === "23505";
}
