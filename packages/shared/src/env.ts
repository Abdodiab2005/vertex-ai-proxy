import { z } from "zod";

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Environment validation failed:\n${issues.join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Validates a process-env-shaped object against a zod schema, throwing a single
 * descriptive error listing every missing/invalid variable instead of failing
 * on the first one. Each app owns its own schema — this only owns the parsing.
 */
export function createEnv<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}
