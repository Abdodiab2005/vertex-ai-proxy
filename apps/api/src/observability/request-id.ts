import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const requestIdStorage = new AsyncLocalStorage<string>();

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

/**
 * The request id is always generated here. It keys usage records and request logs (both unique),
 * so accepting a caller's id would let a caller reuse one and make every later settlement fail
 * after the response was already delivered, i.e. unbilled. A valid caller id is kept alongside
 * for correlation in the access log.
 */
export function resolveRequestIds(
  inboundRequestId: string | undefined,
  generateRequestId: () => string = randomUUID,
): { requestId: string; clientRequestId: string | undefined } {
  const clientRequestId =
    inboundRequestId !== undefined && isValidRequestId(inboundRequestId) ? inboundRequestId : undefined;
  return { requestId: generateRequestId(), clientRequestId };
}

export interface RequestIdCarrier {
  requestId?: string;
}

export function getRequestId(request: RequestIdCarrier): string {
  if (request.requestId === undefined) {
    throw new Error("Request ID middleware has not run for this request.");
  }

  return request.requestId;
}

export function getCurrentRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

export const requestIdMiddleware: RequestHandler = (
  request,
  response,
  next,
): void => {
  const { requestId, clientRequestId } = resolveRequestIds(request.get("x-request-id"));
  request.requestId = requestId;
  request.clientRequestId = clientRequestId;
  response.setHeader("x-request-id", requestId);

  // Running the downstream stack inside this scope lets framework logs retain
  // correlation without making request state globally visible to other requests.
  requestIdStorage.run(requestId, () => next());
};
