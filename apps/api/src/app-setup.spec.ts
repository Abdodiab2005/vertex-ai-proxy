import { describe, expect, it } from "vitest";
import { PUBLIC_API_PATH_PREFIX, requestBodyLimitForPath } from "./app-setup.js";
import { loadApiEnv } from "./config/env.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const publicBodyLimit = 256;
const adminBodyLimit = 128;

const bodySizeEnv = loadApiEnv({
  DB_PASSWORD: "test-password",
  CREDENTIALS_ENCRYPTION_KEY: encryptionKey,
  PUBLIC_MAX_REQUEST_BODY_BYTES: String(publicBodyLimit),
  ADMIN_MAX_REQUEST_BODY_BYTES: String(adminBodyLimit),
});

describe("requestBodyLimitForPath", () => {
  it.each([
    [PUBLIC_API_PATH_PREFIX, publicBodyLimit],
    [`${PUBLIC_API_PATH_PREFIX}/models/gemini`, publicBodyLimit],
    ["/", adminBodyLimit],
    ["/admin/models", adminBodyLimit],
    ["/v1beta-tools", adminBodyLimit],
  ])("selects the correct JSON limit for %s", (pathname, expectedLimit) => {
    expect(requestBodyLimitForPath(pathname, bodySizeEnv)).toBe(expectedLimit);
  });
});
