import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app-setup.js";
import { ConfigService } from "./config/config.service.js";
import { MetricsRegistry } from "./metrics/metrics.registry.js";
import { createApplicationLogger } from "./observability/json-logger.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  const config = app.get(ConfigService);
  const logger = createApplicationLogger(config.env);
  app.useLogger(logger);
  app.flushLogs();
  // Without this a SIGTERM exits at once: streams are cut unbilled and their holds stay locked.
  app.enableShutdownHooks();
  configureApp(app, config.env, {
    accessLogger: logger,
    metrics: app.get(MetricsRegistry),
  });
  await app.listen(config.env.PORT);
  logger.log(`Gateway API listening on port ${config.env.PORT}`, "Bootstrap");
}

await bootstrap();
