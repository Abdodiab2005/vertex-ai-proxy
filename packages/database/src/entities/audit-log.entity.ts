import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

// `before`/`after` capture field-level diffs for admin actions.
// Never put secret values (raw keys, credentials, passwords) in either snapshot —
// callers must redact before writing.
@Entity("audit_logs")
@Index(["createdAt"])
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "admin_user_id", type: "uuid", nullable: true })
  adminUserId: string | null;

  @Column()
  action: string;

  @Column({ name: "entity_type", type: "varchar", nullable: true })
  entityType: string | null;

  @Column({ name: "entity_id", type: "uuid", nullable: true })
  entityId: string | null;

  @Column({ name: "ip_address", type: "inet", nullable: true })
  ipAddress: string | null;

  @Column({ type: "jsonb", nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true })
  after: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
