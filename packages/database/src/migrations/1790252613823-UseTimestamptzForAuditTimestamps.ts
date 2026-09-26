import { MigrationInterface, QueryRunner } from "typeorm";

export class UseTimestamptzForAuditTimestamps1790252613823 implements MigrationInterface {
    name = 'UseTimestamptzForAuditTimestamps1790252613823'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "admin_users" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "admin_users" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "admin_sessions" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "upstreams" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "upstreams" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "models" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "models" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "model_routes" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "model_routes" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "request_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "system_settings" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "usage_aggregates" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "usage_records" ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "usage_records" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "usage_aggregates" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "system_settings" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "request_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "model_routes" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "model_routes" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "models" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "models" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "upstreams" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "upstreams" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "admin_sessions" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "admin_users" ALTER COLUMN "updated_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updated_at" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "admin_users" ALTER COLUMN "created_at" TYPE TIMESTAMP WITHOUT TIME ZONE USING "created_at" AT TIME ZONE 'UTC'`);
    }

}
