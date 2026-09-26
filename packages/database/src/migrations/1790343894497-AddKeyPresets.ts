import { MigrationInterface, QueryRunner } from "typeorm";

export class AddKeyPresets1790343894497 implements MigrationInterface {
    name = 'AddKeyPresets1790343894497'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "key_presets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "description" text, "allowed_models" jsonb NOT NULL DEFAULT '[]', "blocked_models" jsonb NOT NULL DEFAULT '[]', "allowed_endpoints" jsonb NOT NULL DEFAULT '[]', "requests_per_minute" integer, "requests_per_day" integer, "tokens_per_minute" integer, "tokens_per_day" integer, "tokens_per_month" integer, "max_concurrent_requests" integer, "initial_credit" numeric(18,6), "lifetime_days" integer, "tags" jsonb NOT NULL DEFAULT '[]', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_d29f33c213ab0803fbd50a3d487" UNIQUE ("name"), CONSTRAINT "PK_293baa78d62d164de3265d7bd3d" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "key_presets"`);
    }

}
