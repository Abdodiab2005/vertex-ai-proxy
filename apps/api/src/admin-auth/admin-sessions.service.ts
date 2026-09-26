import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { AdminSession, AdminUser } from "@gateway/database";
import { IsNull, MoreThan, Not } from "typeorm";
import type { Repository } from "typeorm";
import { ConfigService } from "../config/config.service.js";

const SESSION_TOKEN_BYTES = 32;
const USER_AGENT_MAX_LENGTH = 512;

export interface CreatedAdminSession {
  session: AdminSession;
  token: string;
}

export interface ResolvedAdminSession {
  session: AdminSession;
  user: AdminUser;
}

export function hashAdminSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function csrfTokenFor(rawToken: string): string {
  return createHash("sha256").update(`csrf:${rawToken}`).digest("base64url");
}

@Injectable()
export class AdminSessionsService {
  constructor(
    @InjectRepository(AdminSession)
    private readonly sessions: Repository<AdminSession>,
    private readonly config: ConfigService,
  ) {}

  async create(
    user: AdminUser,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<CreatedAdminSession> {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const now = new Date();
    const session = this.sessions.create({
      adminUserId: user.id,
      tokenHash: hashAdminSessionToken(token),
      ipAddress: ip ?? null,
      userAgent: userAgent === null || userAgent === undefined
        ? null
        : userAgent.slice(0, USER_AGENT_MAX_LENGTH),
      expiresAt: new Date(now.getTime() + this.sessionTtlMilliseconds),
      revokedAt: null,
    });

    await this.sessions.save(session);

    return { session, token };
  }

  async resolve(rawToken: string): Promise<ResolvedAdminSession | null> {
    const session = await this.sessions.findOne({
      where: { tokenHash: hashAdminSessionToken(rawToken) },
      relations: { adminUser: true },
    });

    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.adminUser.enabled
    ) {
      return null;
    }

    return { session, user: session.adminUser };
  }

  listActive(userId: string): Promise<AdminSession[]> {
    return this.sessions.find({
      where: {
        adminUserId: userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: "DESC" },
    });
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.sessions.update(
      {
        id: sessionId,
        adminUserId: userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      { revokedAt: new Date() },
    );

    return (result.affected ?? 0) > 0;
  }

  async revokeAllExcept(userId: string, keepSessionId: string): Promise<number> {
    const result = await this.sessions.update(
      {
        adminUserId: userId,
        id: Not(keepSessionId),
        revokedAt: IsNull(),
      },
      { revokedAt: new Date() },
    );

    return result.affected ?? 0;
  }

  private get sessionTtlMilliseconds(): number {
    return this.config.env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1_000;
  }
}
