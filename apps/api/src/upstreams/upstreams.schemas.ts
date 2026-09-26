import { z } from "zod";
import {
  parseCredentials,
  UPSTREAM_AUTH_METHODS,
  type CredentialIssue,
} from "./upstream-credentials.js";

const nameSchema = z.string().min(1).max(100);
const projectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "must be a GCP project id");
const locationSchema = z.string().regex(/^[a-z0-9-]{1,50}$/, "must be a Vertex AI location");
const authMethodSchema = z.enum(UPSTREAM_AUTH_METHODS);
const prioritySchema = z.number().int().min(0).max(1000);

export const createUpstreamSchema = z
  .strictObject({
    name: nameSchema,
    provider: z.literal("vertex-ai").default("vertex-ai"),
    enabled: z.boolean().default(true),
    projectId: projectIdSchema,
    location: locationSchema,
    authMethod: authMethodSchema,
    credentials: z.unknown().optional(),
    priority: prioritySchema.default(0),
  })
  .superRefine((value, ctx) => {
    const parsed = parseCredentials(
      value.authMethod,
      value.credentials,
      value.credentials !== undefined,
    );
    if (!parsed.ok) {
      addIssues(ctx, parsed.issues);
    }
  });

export type CreateUpstreamInput = z.output<typeof createUpstreamSchema>;

export const patchUpstreamSchema = z.strictObject({
  name: nameSchema.optional(),
  provider: z.literal("vertex-ai").optional(),
  enabled: z.boolean().optional(),
  projectId: projectIdSchema.optional(),
  location: locationSchema.optional(),
  authMethod: authMethodSchema.optional(),
  credentials: z.unknown().optional(),
  priority: prioritySchema.optional(),
});

export type PatchUpstreamInput = z.output<typeof patchUpstreamSchema>;

export const testUpstreamSchema = z.strictObject({
  model: z.string().min(1).max(200),
});

export type TestUpstreamInput = z.output<typeof testUpstreamSchema>;

function addIssues(
  ctx: { addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void },
  issues: CredentialIssue[],
): void {
  for (const issue of issues) {
    ctx.addIssue({
      code: "custom",
      path: issue.path.split("."),
      message: issue.message,
    });
  }
}
