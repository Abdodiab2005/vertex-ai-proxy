import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAlerts1790362376293 implements MigrationInterface {
    name = 'AddAlerts1790362376293'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "alerts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(100) NOT NULL, "severity" character varying(20) NOT NULL, "dedupe_key" character varying(200) NOT NULL, "title" character varying(500) NOT NULL, "message" text NOT NULL, "data" jsonb, "status" character varying(20) NOT NULL DEFAULT 'active', "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "acknowledged_at" TIMESTAMP WITH TIME ZONE, "acknowledged_by_admin_id" uuid, "resolved_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_60f895662df096bfcdfab7f4b96" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_deac7d80489f99761bde61ccaa" ON "alerts"  ("status", "first_seen_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d64deeeaf9425d2860f893c298" ON "alerts"  ("dedupe_key") WHERE status <> 'resolved'`);
        await queryRunner.query(`ALTER TABLE "alerts" ADD CONSTRAINT "FK_2d332f507682bf8dbdd57cf8c87" FOREIGN KEY ("acknowledged_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "alerts" DROP CONSTRAINT "FK_2d332f507682bf8dbdd57cf8c87"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d64deeeaf9425d2860f893c298"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_deac7d80489f99761bde61ccaa"`);
        await queryRunner.query(`DROP TABLE "alerts"`);
    }

}
