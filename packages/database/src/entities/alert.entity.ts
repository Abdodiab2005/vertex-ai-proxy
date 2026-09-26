import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { AdminUser } from "./admin-user.entity";

export type AlertStatus = "active" | "acknowledged" | "resolved";
export type AlertSeverity = "info" | "warning" | "critical";

@Entity("alerts")
@Index(["dedupeKey"], { unique: true, where: "status <> 'resolved'" })
@Index(["status", "firstSeenAt"])
export class Alert {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // Open vocabulary: credit_80, credit_100, high_error_rate, upstream_unavailable, spend_threshold, etc.
  @Column({ type: "varchar", length: 100 })
  type: string;

  @Column({ type: "varchar", length: 20 })
  severity: AlertSeverity;

  // Deduplication key, e.g., "credit_80:<apiKeyId>", "upstream_unavailable:<upstreamId>"
  @Column({ name: "dedupe_key", type: "varchar", length: 200 })
  dedupeKey: string;

  @Column({ type: "varchar", length: 500 })
  title: string;

  @Column({ type: "text" })
  message: string;

  // Flexible data payload for context (API key ID, upstream ID, error counts, etc.)
  @Column({ type: "jsonb", nullable: true })
  data: Record<string, unknown> | null;

  // A plain string, not a Postgres enum: only key status and ledger types are real enums here.
  @Column({ type: "varchar", length: 20, default: "active" })
  status: AlertStatus;

  @CreateDateColumn({ name: "first_seen_at", type: "timestamptz" })
  firstSeenAt: Date;

  // Set by the evaluator each time the condition is still true; acknowledging must not move it.
  @Column({ name: "last_seen_at", type: "timestamptz", default: () => "now()" })
  lastSeenAt: Date;

  @Column({ name: "acknowledged_at", type: "timestamptz", nullable: true })
  acknowledgedAt: Date | null;

  @Column({ name: "acknowledged_by_admin_id", type: "uuid", nullable: true })
  acknowledgedByAdminId: string | null;

  @ManyToOne(() => AdminUser, { onDelete: "SET NULL" })
  @JoinColumn({ name: "acknowledged_by_admin_id" })
  acknowledgedByAdmin: AdminUser | null;

  @Column({ name: "resolved_at", type: "timestamptz", nullable: true })
  resolvedAt: Date | null;
}