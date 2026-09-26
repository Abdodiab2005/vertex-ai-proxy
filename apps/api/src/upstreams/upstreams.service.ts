import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { Upstream } from "@gateway/database";
import { CredentialCipher } from "@gateway/shared";
import type { Repository } from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import type { UpstreamConnectionTestResult } from "./providers/upstream-provider.js";
import { UpstreamProviderFactory } from "./upstream-provider.factory.js";
import {
  credentialIssueMessages,
  isKnownUpstreamAuthMethod,
  parseCredentials,
  planCredentialUpdate,
  upstreamCredentialAssociatedData,
  type CredentialIssue,
  type ParsedCredentials,
} from "./upstream-credentials.js";
import type { CreateUpstreamInput, PatchUpstreamInput } from "./upstreams.schemas.js";
import { toAuditRecord, toUpstreamView, type UpstreamView } from "./upstream-view.js";

export interface AuditActor {
  adminUserId: string;
  ipAddress: string | null;
}

export interface UpstreamTestResult {
  result: {
    status: Exclude<UpstreamView["status"], "unknown">;
    httpStatus: number | null;
    message: string;
    checkedAt: string;
  };
  upstream: UpstreamView;
}

@Injectable()
export class UpstreamsService {
  constructor(
    @InjectRepository(Upstream)
    private readonly upstreams: Repository<Upstream>,
    private readonly cipher: CredentialCipher,
    private readonly providers: UpstreamProviderFactory,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<UpstreamView[]> {
    const rows = await this.upstreams.find({
      order: { priority: "ASC", name: "ASC" },
    });
    return rows.map((row) => toUpstreamView(row));
  }

  async get(id: string): Promise<UpstreamView> {
    return toUpstreamView(await this.findOrThrow(id));
  }

  async create(input: CreateUpstreamInput, actor: AuditActor): Promise<UpstreamView> {
    const parsed = parseCredentials(
      input.authMethod,
      input.credentials,
      input.credentials !== undefined,
    );
    if (!parsed.ok) {
      throw credentialException(parsed.issues);
    }

    // The id is the encryption associated data, so it has to exist before insert.
    const id = randomUUID();
    const sealed = this.seal(id, parsed.value);

    return this.upstreams.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Upstream);
      await repo.insert({
        id,
        name: input.name,
        provider: input.provider,
        enabled: input.enabled,
        projectId: input.projectId,
        location: input.location,
        authMethod: input.authMethod,
        encryptedCredentials: sealed.encryptedCredentials,
        credentialSummary: sealed.credentialSummary,
        priority: input.priority,
        status: "unknown",
        lastCheckedAt: null,
      });
      const saved = await repo.findOneBy({ id });
      if (saved === null) {
        throw new InternalServerErrorException("Upstream could not be saved.");
      }
      const view = toUpstreamView(saved);
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.UPSTREAM_CREATED,
          adminUserId: actor.adminUserId,
          entityType: "upstream",
          entityId: id,
          ipAddress: actor.ipAddress,
          before: null,
          after: toAuditRecord(view),
        },
        manager,
      );
      return view;
    });
  }

  async update(id: string, input: PatchUpstreamInput, actor: AuditActor): Promise<UpstreamView> {
    const upstreamId = this.parseId(id);

    return this.upstreams.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Upstream);
      const current = await repo.findOne({
        where: { id: upstreamId },
        lock: { mode: "pessimistic_write" },
      });
      if (current === null) {
        throw new NotFoundException("Upstream not found.");
      }

      const currentAuthMethod = this.knownAuthMethod(current.authMethod);
      const nextAuthMethod = input.authMethod ?? currentAuthMethod;
      const plan = planCredentialUpdate({
        currentAuthMethod,
        nextAuthMethod,
        credentials: input.credentials,
        credentialsProvided: input.credentials !== undefined,
      });
      if (!plan.ok) {
        throw credentialException(plan.issues);
      }

      let encryptedCredentials = current.encryptedCredentials;
      let credentialSummary = current.credentialSummary;
      if (plan.value.action === "clear") {
        encryptedCredentials = null;
        credentialSummary = null;
      } else if (plan.value.action === "replace") {
        encryptedCredentials = this.cipher.encrypt(
          plan.value.plaintext,
          upstreamCredentialAssociatedData(current.id),
        );
        credentialSummary = plan.value.summary;
      }

      const credentialsChanged = plan.value.action !== "keep";
      const next = {
        name: input.name ?? current.name,
        provider: input.provider ?? current.provider,
        enabled: input.enabled ?? current.enabled,
        projectId: input.projectId ?? current.projectId,
        location: input.location ?? current.location,
        authMethod: nextAuthMethod,
        priority: input.priority ?? current.priority,
        encryptedCredentials,
        credentialSummary,
      };
      const unchanged =
        !credentialsChanged &&
        next.name === current.name &&
        next.provider === current.provider &&
        next.enabled === current.enabled &&
        next.projectId === current.projectId &&
        next.location === current.location &&
        next.authMethod === current.authMethod &&
        next.priority === current.priority;
      if (unchanged) {
        return toUpstreamView(current);
      }

      await repo.update({ id: current.id }, next);
      const saved = await repo.findOneBy({ id: current.id });
      if (saved === null) {
        throw new NotFoundException("Upstream not found.");
      }
      const before = toUpstreamView(current);
      const after = toUpstreamView(saved);
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.UPSTREAM_UPDATED,
          adminUserId: actor.adminUserId,
          entityType: "upstream",
          entityId: current.id,
          ipAddress: actor.ipAddress,
          before: toAuditRecord(before),
          after: toAuditRecord(after, credentialsChanged),
        },
        manager,
      );
      return after;
    });
  }

  async test(id: string, model: string, actor: AuditActor): Promise<UpstreamTestResult> {
    const upstream = await this.findOrThrow(id);
    const probe = await this.probe(upstream, model);
    const checkedAt = new Date();

    return this.upstreams.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Upstream);
      // update() writes only the probe columns. save() would persist the entity
      // loaded before the probe and could overwrite a concurrent credential change.
      const updated = await repo.update(
        { id: upstream.id },
        { status: probe.status, lastCheckedAt: checkedAt },
      );
      if (updated.affected === 0) {
        throw new NotFoundException("Upstream not found.");
      }
      const saved = await repo.findOneBy({ id: upstream.id });
      if (saved === null || saved.lastCheckedAt === null) {
        throw new NotFoundException("Upstream not found.");
      }
      const before = toUpstreamView(upstream);
      const after = toUpstreamView(saved);
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.UPSTREAM_TESTED,
          adminUserId: actor.adminUserId,
          entityType: "upstream",
          entityId: upstream.id,
          ipAddress: actor.ipAddress,
          before: toAuditRecord(before),
          after: toAuditRecord(after),
        },
        manager,
      );
      return {
        result: {
          status: probe.status,
          httpStatus: probe.httpStatus,
          message: probe.message,
          checkedAt: saved.lastCheckedAt.toISOString(),
        },
        upstream: after,
      };
    });
  }

  private async probe(
    upstream: Upstream,
    model: string,
  ): Promise<UpstreamConnectionTestResult> {
    const provider = this.providers.forUpstream(upstream);
    try {
      return await provider.testConnection(model);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid model id") {
        throw new BadRequestException(["model: invalid model id"]);
      }
      if (error instanceof Error && error.message === "Invalid Vertex AI location") {
        throw new BadRequestException(["location: invalid Vertex AI location"]);
      }
      throw error;
    }
  }

  private seal(
    id: string,
    parsed: ParsedCredentials,
  ): { encryptedCredentials: string | null; credentialSummary: string | null } {
    if (parsed.kind === "none") {
      return { encryptedCredentials: null, credentialSummary: null };
    }

    const plaintext =
      parsed.kind === "api-key"
        ? JSON.stringify(parsed.apiKey)
        : JSON.stringify(parsed.credentials);
    return {
      encryptedCredentials: this.cipher.encrypt(plaintext, upstreamCredentialAssociatedData(id)),
      credentialSummary: parsed.kind === "service-account" ? parsed.summary : null,
    };
  }

  private async findOrThrow(id: string): Promise<Upstream> {
    const upstreamId = this.parseId(id);
    const upstream = await this.upstreams.findOneBy({ id: upstreamId });
    if (upstream === null) {
      throw new NotFoundException("Upstream not found.");
    }
    return upstream;
  }

  private parseId(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new NotFoundException("Upstream not found.");
    }
    return id;
  }

  private knownAuthMethod(value: string) {
    if (!isKnownUpstreamAuthMethod(value)) {
      throw new InternalServerErrorException("Upstream auth method is not supported.");
    }
    return value;
  }
}

function credentialException(issues: CredentialIssue[]): BadRequestException {
  return new BadRequestException(credentialIssueMessages(issues));
}
