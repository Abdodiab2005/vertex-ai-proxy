import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { RoutingStrategy } from "@gateway/contracts";
import { Model } from "./model.entity";
import { Upstream } from "./upstream.entity";

@Entity("model_routes")
export class ModelRoute {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "model_id" })
  modelId: string;

  @ManyToOne(() => Model, { onDelete: "CASCADE" })
  @JoinColumn({ name: "model_id" })
  model: Model;

  @Column({ name: "upstream_id" })
  upstreamId: string;

  @ManyToOne(() => Upstream, { onDelete: "CASCADE" })
  @JoinColumn({ name: "upstream_id" })
  upstream: Upstream;

  @Column({ default: 0 })
  priority: number;

  @Column({ type: "varchar", default: "priority" })
  strategy: RoutingStrategy;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
