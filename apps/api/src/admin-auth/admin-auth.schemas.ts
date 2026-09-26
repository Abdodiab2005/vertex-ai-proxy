import { z } from "zod";

export const adminEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const adminNewPasswordSchema = z.string().min(12).max(256);

export const adminLoginSchema = z.strictObject({
  email: adminEmailSchema,
  password: z.string().min(1).max(1024),
});

export type AdminLoginInput = z.output<typeof adminLoginSchema>;

export const adminPasswordChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(1024),
  newPassword: adminNewPasswordSchema,
});

export type AdminPasswordChangeInput = z.output<typeof adminPasswordChangeSchema>;
