import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { entities } from "@gateway/database";
import { ConfigService } from "../config/config.service.js";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        host: config.env.DB_HOST,
        port: config.env.DB_PORT,
        username: config.env.DB_USERNAME,
        password: config.env.DB_PASSWORD,
        database: config.env.DB_NAME,
        ssl: config.env.DB_SSL,
        // Migrations are the only supported schema-change path; synchronize would edit production.
        synchronize: false,
        entities,
      }),
    }),
  ],
})
export class DatabaseModule {}
