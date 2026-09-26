import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm links next and react from the workspace root, outside this app.
// Tracing stops at the app directory unless the root is the monorepo, and the
// standalone server would then ship without its runtime dependencies.
const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
