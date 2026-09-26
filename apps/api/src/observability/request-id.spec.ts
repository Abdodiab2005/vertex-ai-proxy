import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  getCurrentRequestId,
  getRequestId,
  isValidRequestId,
  requestIdMiddleware,
  resolveRequestIds,
} from "./request-id.js";

function requestWithInboundId(inboundRequestId: string | undefined): Request {
  return {
    get: vi.fn().mockReturnValue(inboundRequestId),
  } as unknown as Request;
}

function responseWithHeaders(): {
  response: Response;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string): void => {
      headers.set(name, value);
    },
  } as unknown as Response;

  return { response, headers };
}

describe("request IDs", () => {
  it.each([
    ["request-01", true],
    ["abc.DEF_123-xyz", true],
    ["short", false],
    ["contains space", false],
    ["contains/slash", false],
    ["a".repeat(129), false],
  ])("validates %s", (requestId, expected) => {
    expect(isValidRequestId(requestId)).toBe(expected);
  });

  it.each([
    ["valid.id-123", "valid.id-123"],
    [undefined, undefined],
    ["not valid", undefined],
  ])("always generates the request ID and keeps only a valid caller ID aside", (inboundRequestId, clientRequestId) => {
    const generated = vi.fn(() => "generated-request-id");

    expect(resolveRequestIds(inboundRequestId, generated)).toEqual({
      requestId: "generated-request-id",
      clientRequestId,
    });
    expect(generated).toHaveBeenCalledTimes(1);
  });

  it("never lets a caller choose the ID that keys usage records", () => {
    const request = requestWithInboundId("attacker-chosen-id");
    const { response, headers } = responseWithHeaders();
    let currentRequestId: string | undefined;
    const next: NextFunction = () => {
      currentRequestId = getCurrentRequestId();
    };

    requestIdMiddleware(request, response, next);

    const requestId = getRequestId(request);
    expect(requestId).not.toBe("attacker-chosen-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.clientRequestId).toBe("attacker-chosen-id");
    expect(currentRequestId).toBe(requestId);
    expect(headers.get("x-request-id")).toBe(requestId);
  });
});
