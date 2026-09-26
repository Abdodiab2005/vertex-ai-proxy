import "reflect-metadata";
import { DataSource } from "typeorm";
import { loadDatabaseEnv } from "./config";
import { entities } from "./entities";

const env = loadDatabaseEnv();

// The TypeORM CLI (`typeorm-ts-node-commonjs -d src/data-source.ts`) requires this
// file to export exactly one DataSource instance — a named export alongside a
// `export default` of the same object counts as two and it refuses to load.
const AppDataSource = new DataSource({
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
  migrations: [__dirname + "/migrations/*.{ts,js}"],
});

export default AppDataSource;
