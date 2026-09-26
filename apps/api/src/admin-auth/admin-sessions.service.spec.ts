import {
  csrfTokenFor,
  hashAdminSessionToken,
} from "./admin-sessions.service.js";

describe("admin session token derivation", () => {
  it("derives a deterministic, distinct CSRF token without exposing the session token or hash", () => {
    const firstToken = "admin-session-token-one";
    const secondToken = "admin-session-token-two";
    const firstCsrfToken = csrfTokenFor(firstToken);

    expect(csrfTokenFor(firstToken)).toBe(firstCsrfToken);
    expect(csrfTokenFor(secondToken)).not.toBe(firstCsrfToken);
    expect(firstCsrfToken).not.toBe(firstToken);
    expect(firstCsrfToken).not.toBe(hashAdminSessionToken(firstToken));
    expect(firstCsrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
