import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "./zod-validation.pipe.js";

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe(
    z.strictObject({
      email: z.email(),
      password: z.string().min(16),
    }),
  );

  function rejectionMessages(input: unknown): string[] {
    try {
      pipe.transform(input);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      return ((error as BadRequestException).getResponse() as { message: string[] }).message;
    }
    throw new Error("expected the pipe to reject the input");
  }

  it("returns parsed input", () => {
    const input = { email: "admin@example.com", password: "a-secure-password" };

    expect(pipe.transform(input)).toEqual(input);
  });

  it("reports each invalid path without exposing submitted values", () => {
    const password = "secret123";
    const messages = rejectionMessages({ email: "not-an-email", password, extra: "x" });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^email: /),
        expect.stringMatching(/^password: /),
        expect.stringMatching(/^: .*extra/),
      ]),
    );
    expect(messages.join(" ")).not.toContain(password);
    expect(messages.join(" ")).not.toContain("not-an-email");
  });

  it("keeps messages intact when a submitted value is a common substring", () => {
    expect(rejectionMessages({ email: "a", password: "a" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^email: Invalid email address$/)]),
    );
  });
});
