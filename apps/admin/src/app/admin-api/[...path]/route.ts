import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_API_URL } from "../../../lib/env";

const FORWARDED_HEADERS = [
  "cookie",
  "content-type",
  "x-csrf-token",
  "user-agent",
  "x-forwarded-for",
];

async function handleRequest(
  req: NextRequest,
  context: RouteContext<"/admin-api/[...path]">
) {
  const params = await context.params;
  const pathSegments = params.path;

  // Validate path segments
  for (const segment of pathSegments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      return NextResponse.json(
        { statusCode: 400, message: "Invalid path segment." },
        { status: 400 }
      );
    }
  }

  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const url = new URL(`${GATEWAY_API_URL}/admin/${encodedPath}`);
  url.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  const method = req.method;
  let body: BodyInit | null = null;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.arrayBuffer(); // Get raw body
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url.toString(), {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json(
      {
        statusCode: 502,
        message: "Gateway API unreachable.",
        error: "Bad Gateway",
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  const copyHeader = (name: string) => {
    const value = upstreamRes.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  };

  copyHeader("content-type");
  copyHeader("content-disposition");
  copyHeader("retry-after");

  for (const cookie of upstreamRes.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }

  // The Response constructor rejects any body, even an empty one, on these statuses;
  // logout, password change and session revocation all answer 204.
  const responseBody = NULL_BODY_STATUSES.has(upstreamRes.status)
    ? null
    : await upstreamRes.arrayBuffer();

  return new NextResponse(responseBody, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
