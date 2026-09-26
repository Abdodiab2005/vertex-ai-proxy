import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { BillingDimension } from "@gateway/contracts";
import { Model } from "./model.entity";

@Entity("pricing_rules")
@Index(["modelId", "billingDimension", "effectiveFrom"])
export class PricingRule {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "model_id" })
  modelId: string;

  @ManyToOne(() => Model, { onDelete: "CASCADE" })
  @JoinColumn({ name: "model_id" })
  model: Model;

  @Column({ name: "billing_dimension", type: "varchar" })
  billingDimension: BillingDimension;

  // Tokens (or other units) per priced unit, e.g. 1_000_000 for "per million tokens".
  @Column({ name: "unit_size", type: "bigint", default: 1_000_000 })
  unitSize: string;

  @Column({ type: "numeric", precision: 18, scale: 8 })
  price: string;

  @Column({ default: "USD" })
  currency: string;

  @Column({ name: "effective_from", type: "timestamptz" })
  effectiveFrom: Date;

  @Column({ name: "effective_to", type: "timestamptz", nullable: true })
  effectiveTo: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
