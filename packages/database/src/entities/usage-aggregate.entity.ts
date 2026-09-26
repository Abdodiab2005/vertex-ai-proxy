import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

// Pre-rolled counters for dashboard/analytics queries so those views
// never have to scan raw usage_records. Populated/refreshed by a background job,
// not written on the request path.
@Entity("usage_aggregates")
@Index(["periodStart", "granularity", "apiKeyId", "modelId"], { unique: true })
export class UsageAggregate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "api_key_id", type: "uuid", nullable: true })
  apiKeyId: string | null;

  @Column({ name: "model_id", type: "uuid", nullable: true })
  modelId: string | null;

  // 'hour' | 'day' | 'month'
  @Column()
  granularity: string;

  @Column({ name: "period_start", type: "timestamptz" })
  periodStart: Date;

  @Column({ name: "period_end", type: "timestamptz" })
  periodEnd: Date;

  @Column({ name: "request_count", type: "int", default: 0 })
  requestCount: number;

  @Column({ name: "success_count", type: "int", default: 0 })
  successCount: number;

  @Column({ name: "error_count", type: "int", default: 0 })
  errorCount: number;

  @Column({ name: "input_tokens", type: "bigint", default: 0 })
  inputTokens: string;

  @Column({ name: "output_tokens", type: "bigint", default: 0 })
  outputTokens: string;

  @Column({ type: "numeric", precision: 18, scale: 6, default: 0 })
  cost: string;

  @Column({ default: "USD" })
  currency: string;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
