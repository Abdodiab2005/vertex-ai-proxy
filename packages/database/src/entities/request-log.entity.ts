import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// Metadata-only request log. Deliberately has NO column for prompt
// text, images, audio, documents, or model responses — content logging is a
// separate, explicit opt-in feature with its own retention policy, never this
// table. No FKs to api_keys/models: a log write must never fail or block on a
// foreign-key constraint.
@Entity("request_logs")
@Index(["createdAt"])
export class RequestLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "request_id", unique: true })
  requestId: string;

  @Column({ name: "api_key_id", type: "uuid", nullable: true })
  apiKeyId: string | null;

  @Column({ type: "varchar", nullable: true })
  model: string | null;

  @Column()
  endpoint: string;

  @Column()
  status: string;

  @Column({ name: "latency_ms", type: "int", nullable: true })
  latencyMs: number | null;

  @Column({ name: "input_tokens", type: "bigint", nullable: true })
  inputTokens: string | null;

  @Column({ name: "output_tokens", type: "bigint", nullable: true })
  outputTokens: string | null;

  @Column({ name: "other_usage_dimensions", type: "jsonb", nullable: true })
  otherUsageDimensions: Record<string, unknown> | null;

  @Column({ name: "calculated_cost", type: "numeric", precision: 18, scale: 6, nullable: true })
  calculatedCost: string | null;

  @Column({ name: "client_ip", type: "inet", nullable: true })
  clientIp: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent: string | null;

  @Column({ type: "varchar", nullable: true })
  upstream: string | null;

  @Column({ name: "error_code", type: "varchar", nullable: true })
  errorCode: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
