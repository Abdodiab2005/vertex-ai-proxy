import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { ApiKey } from "./api-key.entity";
import { Model } from "./model.entity";

// The authoritative per-request accounting row that CreditTransaction debits
// reference. Distinct from RequestLog (lightweight metadata for the logs UI):
// this table is the source of truth for cost, so it keeps the pricing snapshot
// even after PricingRule changes later.
@Entity("usage_records")
@Index(["apiKeyId", "createdAt"])
export class UsageRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "request_id", unique: true })
  requestId: string;

  @Column({ name: "api_key_id" })
  apiKeyId: string;

  @ManyToOne(() => ApiKey, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "api_key_id" })
  apiKey: ApiKey;

  @Column({ name: "model_id" })
  modelId: string;

  @ManyToOne(() => Model, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "model_id" })
  model: Model;

  // Deliberately a plain id, no FK: upstreams can be reassigned/removed without
  // rewriting historical usage.
  @Column({ name: "upstream_id", type: "uuid", nullable: true })
  upstreamId: string | null;

  @Column()
  endpoint: string;

  @Column()
  status: string;

  @Column({ name: "input_tokens", type: "bigint", nullable: true })
  inputTokens: string | null;

  @Column({ name: "output_tokens", type: "bigint", nullable: true })
  outputTokens: string | null;

  // cachedInputTokens, reasoningTokens, audioInputTokens, audioOutputTokens,
  // imageUnits, and any other provider-defined billing units the upstream reports.
  @Column({ name: "other_usage_dimensions", type: "jsonb", nullable: true })
  otherUsageDimensions: Record<string, unknown> | null;

  @Column({ name: "calculated_cost", type: "numeric", precision: 18, scale: 6, nullable: true })
  calculatedCost: string | null;

  @Column({ default: "USD" })
  currency: string;

  // True when upstream usage metadata was missing/incomplete and cost could not
  // be determined — never invent a token count to fill the gap.
  @Column({ name: "cost_undetermined", default: false })
  costUndetermined: boolean;

  // The exact PricingRule values applied at request time, so a later price change
  // never rewrites history: historical requests keep the price they were charged.
  @Column({ name: "pricing_snapshot", type: "jsonb", nullable: true })
  pricingSnapshot: Record<string, unknown> | null;

  @Column({ name: "latency_ms", type: "int", nullable: true })
  latencyMs: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
