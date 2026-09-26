import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

// Presets are copied onto keys at creation. Keys do not reference them, so
// deleting a preset leaves keys that were already issued unchanged.
@Entity("key_presets")
export class KeyPreset {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 100, unique: true })
  name: string;

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

  // Postgres numeric, carried as a string so the amount never passes through a JS float.
  @Column({ name: "initial_credit", type: "numeric", precision: 18, scale: 6, nullable: true })
  initialCredit: string | null;

  @Column({ name: "lifetime_days", type: "int", nullable: true })
  lifetimeDays: number | null;

  @Column({ type: "jsonb", default: () => "'[]'" })
  tags: string[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
