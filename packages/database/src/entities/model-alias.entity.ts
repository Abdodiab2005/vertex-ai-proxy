import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Model } from "./model.entity";

// Aliases are inserted and deleted, never updated, so there is no updated_at.
// Uniqueness against models.public_name cannot be a single index across two
// tables; the model service enforces that inside the write transaction.
@Entity("model_aliases")
@Index(["modelId"])
export class ModelAlias {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", unique: true })
  alias: string;

  @Column({ name: "model_id" })
  modelId: string;

  @ManyToOne(() => Model, { onDelete: "CASCADE" })
  @JoinColumn({ name: "model_id" })
  model: Model;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
