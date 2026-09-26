import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ApiKeyStatus } from "@gateway/contracts";

@Entity("api_keys")
export class ApiKey {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  // Short, non-secret prefix (e.g. "lvg_ab12") shown in the admin UI so a key is
  // recognizable without ever displaying the secret again after creation.
  @Column({ name: "key_prefix" })
  keyPrefix: string;

  // Hash of the full raw key. The raw key itself is never persisted anywhere.
  @Column({ name: "key_hash", unique: true })
  keyHash: string;

  @Column({ type: "enum", enum: ApiKeyStatus, default: ApiKeyStatus.ACTIVE })
  status: ApiKeyStatus;

  @Column({ type: "text", nullable: true })
  description: string | null;

  // TypeORM 1.1.1 strips `::jsonb` from information_schema defaults before comparing,
  // so the entity spelling that matches the stored default is `'[]'`.
  @Column({ name: "allowed_models", type: "jsonb", default: () => "'[]'" })
  allowedModels: string[];

  @Column({ name: "blocked_models", type: "jsonb", default: () => "'[]'" })
  blockedModels: string[];

  @Column({ name: "allowed_endpoints", type: "jsonb", default: () => "'[]'" })
  allowedEndpoints: string[];

  @Column({ name: "requests_per_minute", type: "int", nullable: true })
  requestsPerMinute: number | null;

  @Column({ name: "requests_per_day", type: "int", nullable: true })
  requestsPerDay: number | null;

  @Column({ name: "tokens_per_minute", type: "int", nullable: true })
  tokensPerMinute: number | null;

  @Column({ name: "tokens_per_day", type: "int", nullable: true })
  tokensPerDay: number | null;

  @Column({ name: "tokens_per_month", type: "int", nullable: true })
  tokensPerMonth: number | null;

  @Column({ name: "max_concurrent_requests", type: "int", nullable: true })
  maxConcurrentRequests: number | null;

  @Column({ name: "allowed_ips", type: "jsonb", default: () => "'[]'" })
  allowedIPs: string[];

  @Column({ name: "blocked_ips", type: "jsonb", default: () => "'[]'" })
  blockedIPs: string[];

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: "jsonb", default: () => "'[]'" })
  tags: string[];

  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt: Date | null;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
