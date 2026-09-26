import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { AdminSession } from "./admin-session.entity";

@Entity("admin_users")
export class AdminUser {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true })
  email: string;

  // Argon2id hash — never a raw password, never logged or audited.
  @Column({ name: "password_hash" })
  passwordHash: string;

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: "last_login_at", type: "timestamptz", nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;

  @OneToMany(() => AdminSession, (session) => session.adminUser)
  sessions: AdminSession[];
}
