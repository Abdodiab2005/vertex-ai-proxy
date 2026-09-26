import { DataSource } from "typeorm";
import { AdminUser, AuditLog } from "@gateway/database";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { PasswordHasher } from "../security/password-hasher.js";
import { adminEmailSchema, adminNewPasswordSchema } from "../admin-auth/admin-auth.schemas.js";
import { z } from "zod";

export class OwnerAlreadyExistsError extends Error {
  constructor() {
    super("Owner account already exists");
    this.name = "OwnerAlreadyExistsError";
  }
}

export class InvalidOwnerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOwnerInputError";
  }
}

export interface BootstrapOwnerInput {
  email: string;
  password: string;
}

export interface BootstrapOwnerResult {
  id: string;
  email: string;
}

const bootstrapInputSchema = z.strictObject({
  email: adminEmailSchema,
  password: adminNewPasswordSchema,
});

export function validateBootstrapOwnerInput(input: BootstrapOwnerInput): {
  email: string;
  password: string;
} {
  const result = bootstrapInputSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new InvalidOwnerInputError(message);
  }
  return result.data;
}

export async function bootstrapOwner(
  dataSource: DataSource,
  hasher: PasswordHasher,
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  const { email, password } = validateBootstrapOwnerInput(input);

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    await queryRunner.query(`LOCK TABLE admin_users IN SHARE ROW EXCLUSIVE MODE`);

    const existingCount = await queryRunner.manager.count(AdminUser);
    if (existingCount > 0) {
      throw new OwnerAlreadyExistsError();
    }

    const passwordHash = await hasher.hash(password);

    const adminUser = queryRunner.manager.create(AdminUser, {
      email,
      passwordHash,
      enabled: true,
    });
    const savedUser = await queryRunner.manager.save(adminUser);

    const auditLog = queryRunner.manager.create(AuditLog, {
      adminUserId: savedUser.id,
      action: ADMIN_AUDIT_ACTIONS.OWNER_BOOTSTRAPPED,
      entityType: "admin_user",
      entityId: savedUser.id,
      after: { email: savedUser.email },
    });
    await queryRunner.manager.save(auditLog);

    await queryRunner.commitTransaction();

    return { id: savedUser.id, email: savedUser.email };
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}