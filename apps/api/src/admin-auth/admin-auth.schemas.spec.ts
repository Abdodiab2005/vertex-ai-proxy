import {
  adminLoginSchema,
  adminPasswordChangeSchema,
} from "./admin-auth.schemas.js";

describe("admin authentication schemas", () => {
  it("normalizes a login email", () => {
    const parsed = adminLoginSchema.parse({
      email: "  ADMIN@Example.COM  ",
      password: "password",
    });

    expect(parsed.email).toBe("admin@example.com");
  });

  it("rejects unknown login and password-change fields", () => {
    expect(
      adminLoginSchema.safeParse({
        email: "admin@example.com",
        password: "password",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      adminPasswordChangeSchema.safeParse({
        currentPassword: "current-password",
        newPassword: "a".repeat(12),
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("enforces login password length limits", () => {
    expect(
      adminLoginSchema.safeParse({ email: "admin@example.com", password: "" }).success,
    ).toBe(false);
    expect(
      adminLoginSchema.safeParse({
        email: "admin@example.com",
        password: "a".repeat(1025),
      }).success,
    ).toBe(false);
  });

  it("enforces password-change length limits", () => {
    expect(
      adminPasswordChangeSchema.safeParse({
        currentPassword: "current-password",
        newPassword: "a".repeat(11),
      }).success,
    ).toBe(false);
    expect(
      adminPasswordChangeSchema.safeParse({
        currentPassword: "",
        newPassword: "a".repeat(12),
      }).success,
    ).toBe(false);
    expect(
      adminPasswordChangeSchema.safeParse({
        currentPassword: "current-password",
        newPassword: "a".repeat(257),
      }).success,
    ).toBe(false);
  });
});
