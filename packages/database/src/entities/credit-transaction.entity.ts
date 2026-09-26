import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Check } from "typeorm";
import { CreditTransactionType } from "@gateway/contracts";
import { ApiKey } from "./api-key.entity";

// Append-only ledger: rows are never updated or deleted after creation. The
// CreditLedgerConstraints migration enforces it with a trigger that rejects UPDATE and DELETE.
// Balance is always derived by summing this table, never stored as a single
// mutable counter — see docs/BILLING_AND_CREDITS.md.
@Entity("credit_transactions")
@Check("chk_credit_transactions_sign", "(type = 'credit_added' AND amount > 0) OR (type = 'credit_removed' AND amount < 0) OR (type = 'cost_consumed' AND amount <= 0) OR (type = 'refund' AND amount > 0) OR (type = 'manual_adjustment' AND amount != 0)")
@Index(["apiKeyId", "createdAt"])
export class CreditTransaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "api_key_id" })
  apiKeyId: string;

  @ManyToOne(() => ApiKey, { onDelete: "CASCADE" })
  @JoinColumn({ name: "api_key_id" })
  apiKey: ApiKey;

  @Column({ type: "enum", enum: CreditTransactionType })
  type: CreditTransactionType;

  // Fixed-precision decimal, never a JS float — signed (negative for debits).
  @Column({ type: "numeric", precision: 18, scale: 6 })
  amount: string;

  @Column({ default: "USD" })
  currency: string;

  @Column({ name: "usage_record_id", type: "uuid", nullable: true })
  usageRecordId: string | null;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ name: "created_by_admin_id", type: "uuid", nullable: true })
  createdByAdminId: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
