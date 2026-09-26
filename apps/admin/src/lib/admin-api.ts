import { isRecord } from "./types";

export async function fetchAdminApi(
  path: string,
  options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    csrfToken: string;
    body?: unknown;
  },
): Promise<Response> {
  const headers = new Headers();
  // Only set CSRF token for mutating methods
  if (options.method !== "GET") {
    headers.set("x-csrf-token", options.csrfToken);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  return fetch(`/admin-api${path}`, {
    method: options.method,
    headers,
    body,
  });
}

export async function readResponseBody(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export function errorMessageForStatus(
  status: number,
  body: unknown,
  notFoundMessage?: string,
): string | string[] {
  if (status === 400) {
    const message = nestErrorMessage(body);
    if (message !== null) {
      return message;
    }
    return "Please check the form and try again.";
  }
  if (status === 403) {
    return "Your session expired. Reload the page and try again.";
  }
  if (status === 404) {
    return notFoundMessage ?? "This item no longer exists.";
  }
  if (status === 409) {
    const message = nestErrorMessage(body);
    if (message !== null) {
      return message;
    }
    return "This change conflicts with the current state.";
  }
  return `Something went wrong (HTTP ${status}).`;
}

function nestErrorMessage(body: unknown): string | string[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const message = body.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  if (
    Array.isArray(message) &&
    message.length > 0 &&
    message.every((item) => typeof item === "string")
  ) {
    return message;
  }
  return null;
}
