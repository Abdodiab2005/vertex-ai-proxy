import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { ModelAvailabilityStatus, ModelProvider } from "@gateway/contracts";
import { Upstream } from "./upstream.entity";

@Entity("models")
export class Model {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // The name clients request, e.g. "gemini-2.5-flash" — independent of whatever
  // the upstream actually calls it, so admins can alias/rename without breaking clients.
  @Column({ name: "public_name", unique: true })
  publicName: string;

  @Column({ name: "upstream_model_name" })
  upstreamModelName: string;

  @Column({ name: "display_name" })
  displayName: string;

  @Column({ type: "varchar" })
  provider: ModelProvider;

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: "availability_status", type: "varchar", default: "available" })
  availabilityStatus: ModelAvailabilityStatus;

  @Column({ name: "supports_text", default: true })
  supportsText: boolean;

  @Column({ name: "supports_vision", default: false })
  supportsVision: boolean;

  @Column({ name: "supports_audio", default: false })
  supportsAudio: boolean;

  @Column({ name: "supports_video", default: false })
  supportsVideo: boolean;

  @Column({ name: "supports_files", default: false })
  supportsFiles: boolean;

  @Column({ name: "supports_tools", default: false })
  supportsTools: boolean;

  @Column({ name: "supports_streaming", default: false })
  supportsStreaming: boolean;

  @Column({ name: "supports_embeddings", default: false })
  supportsEmbeddings: boolean;

  @Column({ name: "input_token_limit", type: "int", nullable: true })
  inputTokenLimit: number | null;

  @Column({ name: "output_token_limit", type: "int", nullable: true })
  outputTokenLimit: number | null;

  @Column({ name: "upstream_id" })
  upstreamId: string;

  @ManyToOne(() => Upstream, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "upstream_id" })
  upstream: Upstream;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
