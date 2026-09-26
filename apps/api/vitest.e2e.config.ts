import { defineConfig } from "vitest/config";
import { nestjsDecoratorMetadata } from "./test/nestjs-decorator-metadata.js";

export default defineConfig({
  plugins: [nestjsDecoratorMetadata()],
  test: {
    globals: true,
    root: "./",
    include: ["test/**/*.e2e-spec.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-e2e.ts"],
  },
});
