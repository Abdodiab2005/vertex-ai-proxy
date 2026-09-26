import { z } from "zod";
import { createEnv, EnvValidationError } from "./env";

describe("createEnv", () => {
  const schema = z.object({
    PORT: z.coerce.number().default(3000),
    REQUIRED_VALUE: z.string().min(1),
  });

  it("parses a valid environment and applies defaults", () => {
    const env = createEnv(schema, { REQUIRED_VALUE: "hello" });
    expect(env.REQUIRED_VALUE).toBe("hello");
    expect(env.PORT).toBe(3000);
  });

  it("throws EnvValidationError listing every missing/invalid variable", () => {
    expect(() => createEnv(schema, {})).toThrow(EnvValidationError);
    try {
      createEnv(schema, {});
      throw new Error("expected createEnv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});
