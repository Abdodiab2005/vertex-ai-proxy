import { MigrationInterface, QueryRunner } from "typeorm";

export class CreditLedgerConstraints1790329270647 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_transactions"
      ADD CONSTRAINT "chk_credit_transactions_sign" CHECK (
        (type = 'credit_added' AND amount > 0) OR
        (type = 'credit_removed' AND amount < 0) OR
        (type = 'cost_consumed' AND amount <= 0) OR
        (type = 'refund' AND amount > 0) OR
        (type = 'manual_adjustment' AND amount != 0)
      );
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION check_credit_transactions_append_only()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'credit_transactions is append-only';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_credit_transactions_append_only
      BEFORE UPDATE OR DELETE ON "credit_transactions"
      FOR EACH ROW EXECUTE FUNCTION check_credit_transactions_append_only();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_credit_transactions_append_only ON "credit_transactions";`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS check_credit_transactions_append_only();`);
    await queryRunner.query(`ALTER TABLE "credit_transactions" DROP CONSTRAINT IF EXISTS "chk_credit_transactions_sign";`);
  }
}
