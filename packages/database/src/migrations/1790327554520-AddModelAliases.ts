import { MigrationInterface, QueryRunner } from "typeorm";

export class AddModelAliases1790327554520 implements MigrationInterface {
    name = 'AddModelAliases1790327554520'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "model_aliases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "alias" character varying NOT NULL, "model_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_f30eb06fb7b612261acc8ff8605" UNIQUE ("alias"), CONSTRAINT "PK_7ac276e33d7cdd4a2ad44c01099" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_843c2cb6e9239cc3891eb3b0c3" ON "model_aliases"  ("model_id") `);
        await queryRunner.query(`ALTER TABLE "model_aliases" ADD CONSTRAINT "FK_843c2cb6e9239cc3891eb3b0c31" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "model_aliases" DROP CONSTRAINT "FK_843c2cb6e9239cc3891eb3b0c31"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_843c2cb6e9239cc3891eb3b0c3"`);
        await queryRunner.query(`DROP TABLE "model_aliases"`);
    }

}
