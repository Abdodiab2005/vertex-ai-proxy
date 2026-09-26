import "reflect-metadata";

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { entities, loadDatabaseEnv, type DatabaseEnv } from "@gateway/database";
import { DataSource } from "typeorm";
import { TEST_DATABASE_NAME, assertSafeTestTargets } from "./safe-targets.js";

export async function setup(): Promise<void> {
  assertSafeTestTargets();

  const migrationsDirectory = fileURLToPath(
    new URL("../../../packages/database/dist/migrations/", import.meta.url),
  );
  const migrationFiles = readdirSync(migrationsDirectory).filter(
    (name) => name.endsWith(".js") && !name.endsWith(".js.map"),
  );
  if (migrationFiles.length === 0) {
    throw new Error(
      `No built migrations found in ${migrationsDirectory}. Build @gateway/database before the e2e suite.`,
    );
  }

  const env = loadDatabaseEnv();
  await ensureTestDatabaseExists(env);
  console.log(
    `e2e: applying migrations to database ${JSON.stringify(env.DB_NAME)}`,
  );

  const dataSource = new DataSource({
    type: "postgres",
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl: env.DB_SSL,
    synchronize: false,
    logging: false,
    entities,
    migrations: [
      fileURLToPath(
        new URL("../../../packages/database/dist/migrations/*.js", import.meta.url),
      ),
    ],
  });

  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

// Each worktree runs against its own E2E_DB_NAME so branches with different
// migrations never share a schema; create it on first use.
async function ensureTestDatabaseExists(env: DatabaseEnv): Promise<void> {
  if (!TEST_DATABASE_NAME.test(env.DB_NAME)) {
    throw new Error(`Refusing to create database ${JSON.stringify(env.DB_NAME)}`);
  }

  const maintenance = new DataSource({
    type: "postgres",
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: "postgres",
    ssl: env.DB_SSL,
  });
  await maintenance.initialize();
  try {
    const existing: unknown[] = await maintenance.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [env.DB_NAME],
    );
    if (existing.length === 0) {
      console.log(`e2e: creating database ${JSON.stringify(env.DB_NAME)}`);
      // The name is validated against TEST_DATABASE_NAME above, so quoting it is safe.
      await maintenance.query(`CREATE DATABASE "${env.DB_NAME}"`).catch((error: unknown) => {
        throw new Error(
          `Could not create ${env.DB_NAME} (${error instanceof Error ? error.message : String(error)}). ` +
            `Grant the role CREATEDB once: sudo -u postgres psql -c "ALTER ROLE ${env.DB_USERNAME} CREATEDB"`,
        );
      });
    }
  } finally {
    await maintenance.destroy();
  }
}
