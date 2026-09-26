import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUpstreamProviderAndCredentialSummary1790328443565 implements MigrationInterface {
    name = 'AddUpstreamProviderAndCredentialSummary1790328443565'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "upstreams" ADD "provider" character varying NOT NULL DEFAULT 'vertex-ai'`);
        await queryRunner.query(`ALTER TABLE "upstreams" ADD "credential_summary" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "upstreams" DROP COLUMN "credential_summary"`);
        await queryRunner.query(`ALTER TABLE "upstreams" DROP COLUMN "provider"`);
    }

}
