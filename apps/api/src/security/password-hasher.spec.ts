import { PasswordHasher } from "./password-hasher.js";

describe("PasswordHasher", () => {
  const hasher = new PasswordHasher();

  it("creates an Argon2id hash with the configured parameters", async () => {
    await expect(hasher.hash("correct horse battery staple")).resolves.toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
  });

  it.each([
    ["the correct password", true],
    ["an incorrect password", false],
  ])("verifies passwords", async (plain, expected) => {
    const storedHash = await hasher.hash("the correct password");

    await expect(hasher.verify(storedHash, plain)).resolves.toBe(expected);
  });

  it("returns false after verifying against a dummy hash for an unknown account", async () => {
    await expect(hasher.verify(null, "any password")).resolves.toBe(false);
  });

  it("throws for a malformed stored hash", async () => {
    await expect(hasher.verify("not an argon2 hash", "any password")).rejects.toThrow();
  });
});
