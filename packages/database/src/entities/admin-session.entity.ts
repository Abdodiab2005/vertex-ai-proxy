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

@Entity("admin_sessions")
@Index(["adminUserId"])
export class AdminSession {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "admin_user_id" })
  adminUserId: string;

  @ManyToOne(() => AdminUser, (user) => user.sessions, { onDelete: "CASCADE" })
  @JoinColumn({ name: "admin_user_id" })
  adminUser: AdminUser;

  // Hash of the session/JWT token, never the raw token — same reasoning as API keys.
  @Column({ name: "token_hash", unique: true })
  tokenHash: string;

  @Column({ name: "ip_address", type: "inet", nullable: true })
  ipAddress: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent: string | null;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
