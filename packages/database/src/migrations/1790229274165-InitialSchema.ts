import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1790229274165 implements MigrationInterface {
    name = 'InitialSchema1790229274165'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admin_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "last_login_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_dcd0c8a4b10af9c986e510b9ecc" UNIQUE ("email"), CONSTRAINT "PK_06744d221bb6145dc61e5dc441d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "admin_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "admin_user_id" uuid NOT NULL, "token_hash" character varying NOT NULL, "ip_address" inet, "user_agent" text, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_820cb9c73b9f2bf3f2fb678d935" UNIQUE ("token_hash"), CONSTRAINT "PK_38bb553c2372215d48de2306c5e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c1711b1831bdf66b77c3605bcd" ON "admin_sessions" ("admin_user_id") `);
        await queryRunner.query(`CREATE TYPE "public"."api_keys_status_enum" AS ENUM('active', 'suspended', 'revoked', 'expired', 'credit_exhausted')`);
        await queryRunner.query(`CREATE TABLE "api_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "key_prefix" character varying NOT NULL, "key_hash" character varying NOT NULL, "status" "public"."api_keys_status_enum" NOT NULL DEFAULT 'active', "description" text, "allowed_models" jsonb NOT NULL DEFAULT '[]'::jsonb, "blocked_models" jsonb NOT NULL DEFAULT '[]'::jsonb, "allowed_endpoints" jsonb NOT NULL DEFAULT '[]'::jsonb, "requests_per_minute" integer, "requests_per_day" integer, "tokens_per_minute" integer, "tokens_per_day" integer, "tokens_per_month" integer, "max_concurrent_requests" integer, "allowed_ips" jsonb NOT NULL DEFAULT '[]'::jsonb, "blocked_ips" jsonb NOT NULL DEFAULT '[]'::jsonb, "metadata" jsonb, "tags" jsonb NOT NULL DEFAULT '[]'::jsonb, "expires_at" TIMESTAMP WITH TIME ZONE, "last_used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_57384430aa1959f4578046c9b81" UNIQUE ("key_hash"), CONSTRAINT "PK_5c8a79801b44bd27b79228e1dad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "admin_user_id" uuid, "action" character varying NOT NULL, "entity_type" character varying, "entity_id" uuid, "ip_address" inet, "before" jsonb, "after" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2cd10fda8276bb995288acfbfb" ON "audit_logs" ("created_at") `);
        await queryRunner.query(`CREATE TYPE "public"."credit_transactions_type_enum" AS ENUM('credit_added', 'credit_removed', 'cost_consumed', 'manual_adjustment', 'refund')`);
        await queryRunner.query(`CREATE TABLE "credit_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "api_key_id" uuid NOT NULL, "type" "public"."credit_transactions_type_enum" NOT NULL, "amount" numeric(18,6) NOT NULL, "currency" character varying NOT NULL DEFAULT 'USD', "usage_record_id" uuid, "description" text, "created_by_admin_id" uuid, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a408319811d1ab32832ec86fc2c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_07d5d29521c273436f23885d92" ON "credit_transactions" ("api_key_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "upstreams" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "project_id" character varying NOT NULL, "location" character varying NOT NULL, "auth_method" character varying NOT NULL, "encrypted_credentials" text, "priority" integer NOT NULL DEFAULT '0', "status" character varying NOT NULL DEFAULT 'unknown', "last_checked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c10fe4457ecebaba31b3c806be2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "models" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_name" character varying NOT NULL, "upstream_model_name" character varying NOT NULL, "display_name" character varying NOT NULL, "provider" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "availability_status" character varying NOT NULL DEFAULT 'available', "supports_text" boolean NOT NULL DEFAULT true, "supports_vision" boolean NOT NULL DEFAULT false, "supports_audio" boolean NOT NULL DEFAULT false, "supports_video" boolean NOT NULL DEFAULT false, "supports_files" boolean NOT NULL DEFAULT false, "supports_tools" boolean NOT NULL DEFAULT false, "supports_streaming" boolean NOT NULL DEFAULT false, "supports_embeddings" boolean NOT NULL DEFAULT false, "input_token_limit" integer, "output_token_limit" integer, "upstream_id" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_2a4a23e7f982b1840b77d051257" UNIQUE ("public_name"), CONSTRAINT "PK_ef9ed7160ea69013636466bf2d5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "model_routes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "model_id" uuid NOT NULL, "upstream_id" uuid NOT NULL, "priority" integer NOT NULL DEFAULT '0', "strategy" character varying NOT NULL DEFAULT 'priority', "enabled" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_510bb7e7d205f8fde250eb7d813" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "pricing_rules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "model_id" uuid NOT NULL, "billing_dimension" character varying NOT NULL, "unit_size" bigint NOT NULL DEFAULT '1000000', "price" numeric(18,8) NOT NULL, "currency" character varying NOT NULL DEFAULT 'USD', "effective_from" TIMESTAMP WITH TIME ZONE NOT NULL, "effective_to" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_fda27bb8db4630894decda61ff6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d83237795834f96c0c1fc1f62d" ON "pricing_rules" ("model_id", "billing_dimension", "effective_from") `);
        await queryRunner.query(`CREATE TABLE "request_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "request_id" character varying NOT NULL, "api_key_id" uuid, "model" character varying, "endpoint" character varying NOT NULL, "status" character varying NOT NULL, "latency_ms" integer, "input_tokens" bigint, "output_tokens" bigint, "other_usage_dimensions" jsonb, "calculated_cost" numeric(18,6), "client_ip" inet, "user_agent" text, "upstream" character varying, "error_code" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_c3473f89532dbd640696cf61ed9" UNIQUE ("request_id"), CONSTRAINT "PK_1edd3815ae37a9b9511f5a26dca" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_87b7eb47f818e3858c6cbaec9e" ON "request_logs" ("created_at") `);
        await queryRunner.query(`CREATE TABLE "system_settings" ("key" character varying NOT NULL, "value" jsonb NOT NULL, "updated_by_admin_id" uuid, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b1b5bc664526d375c94ce9ad43d" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TABLE "usage_aggregates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "api_key_id" uuid, "model_id" uuid, "granularity" character varying NOT NULL, "period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "period_end" TIMESTAMP WITH TIME ZONE NOT NULL, "request_count" integer NOT NULL DEFAULT '0', "success_count" integer NOT NULL DEFAULT '0', "error_count" integer NOT NULL DEFAULT '0', "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "cost" numeric(18,6) NOT NULL DEFAULT '0', "currency" character varying NOT NULL DEFAULT 'USD', "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f9733d4d246ea620b55039c0d01" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ea24b11f64caf6534bddcee306" ON "usage_aggregates" ("period_start", "granularity", "api_key_id", "model_id") `);
        await queryRunner.query(`CREATE TABLE "usage_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "request_id" character varying NOT NULL, "api_key_id" uuid NOT NULL, "model_id" uuid NOT NULL, "upstream_id" uuid, "endpoint" character varying NOT NULL, "status" character varying NOT NULL, "input_tokens" bigint, "output_tokens" bigint, "other_usage_dimensions" jsonb, "calculated_cost" numeric(18,6), "currency" character varying NOT NULL DEFAULT 'USD', "cost_undetermined" boolean NOT NULL DEFAULT false, "pricing_snapshot" jsonb, "latency_ms" integer, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_d6b7bd75d13514c338ec342a22b" UNIQUE ("request_id"), CONSTRAINT "PK_e511cf9f7dc53851569f87467a5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d205ab027d95fb846654e40e88" ON "usage_records" ("api_key_id", "created_at") `);
        await queryRunner.query(`ALTER TABLE "admin_sessions" ADD CONSTRAINT "FK_c1711b1831bdf66b77c3605bcdb" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ADD CONSTRAINT "FK_af0858bfd6bb90e3c3acff81343" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "models" ADD CONSTRAINT "FK_db7a72832da5eb92b32bdd03754" FOREIGN KEY ("upstream_id") REFERENCES "upstreams"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "model_routes" ADD CONSTRAINT "FK_7ad0154f4fd399a91f5597aad5c" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "model_routes" ADD CONSTRAINT "FK_0580ab42267f65736f3c6643518" FOREIGN KEY ("upstream_id") REFERENCES "upstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ADD CONSTRAINT "FK_7f5d0d83c4804a2794260efa2f9" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "usage_records" ADD CONSTRAINT "FK_25f881c575d75b946cd89c30665" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "usage_records" ADD CONSTRAINT "FK_439c905d518ea131a065549bc10" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "usage_records" DROP CONSTRAINT "FK_439c905d518ea131a065549bc10"`);
        await queryRunner.query(`ALTER TABLE "usage_records" DROP CONSTRAINT "FK_25f881c575d75b946cd89c30665"`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" DROP CONSTRAINT "FK_7f5d0d83c4804a2794260efa2f9"`);
        await queryRunner.query(`ALTER TABLE "model_routes" DROP CONSTRAINT "FK_0580ab42267f65736f3c6643518"`);
        await queryRunner.query(`ALTER TABLE "model_routes" DROP CONSTRAINT "FK_7ad0154f4fd399a91f5597aad5c"`);
        await queryRunner.query(`ALTER TABLE "models" DROP CONSTRAINT "FK_db7a72832da5eb92b32bdd03754"`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" DROP CONSTRAINT "FK_af0858bfd6bb90e3c3acff81343"`);
        await queryRunner.query(`ALTER TABLE "admin_sessions" DROP CONSTRAINT "FK_c1711b1831bdf66b77c3605bcdb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d205ab027d95fb846654e40e88"`);
        await queryRunner.query(`DROP TABLE "usage_records"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ea24b11f64caf6534bddcee306"`);
        await queryRunner.query(`DROP TABLE "usage_aggregates"`);
        await queryRunner.query(`DROP TABLE "system_settings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_87b7eb47f818e3858c6cbaec9e"`);
        await queryRunner.query(`DROP TABLE "request_logs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d83237795834f96c0c1fc1f62d"`);
        await queryRunner.query(`DROP TABLE "pricing_rules"`);
        await queryRunner.query(`DROP TABLE "model_routes"`);
        await queryRunner.query(`DROP TABLE "models"`);
        await queryRunner.query(`DROP TABLE "upstreams"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_07d5d29521c273436f23885d92"`);
        await queryRunner.query(`DROP TABLE "credit_transactions"`);
        await queryRunner.query(`DROP TYPE "public"."credit_transactions_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2cd10fda8276bb995288acfbfb"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
        await queryRunner.query(`DROP TABLE "api_keys"`);
        await queryRunner.query(`DROP TYPE "public"."api_keys_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c1711b1831bdf66b77c3605bcd"`);
        await queryRunner.query(`DROP TABLE "admin_sessions"`);
        await queryRunner.query(`DROP TABLE "admin_users"`);
    }

}
