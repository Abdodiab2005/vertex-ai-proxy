import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import type { ModelProvider, UpstreamAuthMethod, UpstreamConnectionStatus } from "@gateway/contracts";

@Entity("upstreams")
export class Upstream {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ type: "varchar", default: "vertex-ai" })
  provider: ModelProvider;

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: "project_id" })
  projectId: string;

  @Column()
  location: string;

  @Column({ name: "auth_method", type: "varchar" })
  authMethod: UpstreamAuthMethod;

  // AES-256-GCM ciphertext (+ iv/tag) of the credential payload, application-level
  // encrypted — never the plaintext service account JSON / API key. Master key
  // lives only in the deploying environment's env vars, never in this DB.
  @Column({ name: "encrypted_credentials", type: "text", nullable: true })
  encryptedCredentials: string | null;

  // Non-secret label (a service account's client_email) so the admin UI can show
  // which credential is stored without decrypting the payload.
  @Column({ name: "credential_summary", type: "varchar", nullable: true })
  credentialSummary: string | null;

  @Column({ default: 0 })
  priority: number;

  @Column({ type: "varchar", default: "unknown" })
  status: UpstreamConnectionStatus;

  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
