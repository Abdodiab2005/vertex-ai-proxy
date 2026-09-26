import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

// Generic key/value store for the global controls (kill switch,
// maintenance mode, default limits, retention policy, etc.) so new settings
// never need a migration — just a new key.
@Entity("system_settings")
export class SystemSetting {
  @PrimaryColumn()
  key: string;

  @Column({ type: "jsonb" })
  value: unknown;

  @Column({ name: "updated_by_admin_id", type: "uuid", nullable: true })
  updatedByAdminId: string | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
