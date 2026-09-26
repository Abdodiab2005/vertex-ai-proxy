import { cookies } from "next/headers";
import { GATEWAY_API_URL } from "./env";

export async function fetchGatewayAdmin<T>(
  path: string,
): Promise<{ status: number; data: T | null; errorMessage: string | null }> {
  // path is expected to start with "/" (e.g. "/auth/me")
  const url = `${GATEWAY_API_URL}/admin${path}`;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("gw_admin_session");

  const headers = new Headers();
  if (sessionCookie) {
    headers.set("cookie", `gw_admin_session=${sessionCookie.value}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers,
    });
  } catch {
    // Unreachable API: let the page show its error panel instead of crashing.
    return { status: 502, data: null, errorMessage: "Gateway API unreachable." };
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    try {
      const data = (await response.json()) as T;
      return { status, data, errorMessage: null };
    } catch {
      return { status, data: null, errorMessage: null };
    }
  }

  let errorMessage: string | null = null;
  try {
    errorMessage = messageFromBody(await response.json());
  } catch {
    errorMessage = null;
  }
  return { status, data: null, errorMessage };
}

function messageFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("message" in body)) {
    return null;
  }
  const message = body.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  if (Array.isArray(message) && message.every((item) => typeof item === "string")) {
    return message.join("; ");
  }
  return null;
}
