export function getGatewayApiUrl(): string {
  const url = process.env.GATEWAY_API_URL || "http://localhost:3000";
  try {
    const parsed = new URL(url);
    let origin = parsed.origin + parsed.pathname;
    if (origin.endsWith('/')) {
      origin = origin.slice(0, -1);
    }
    return origin;
  } catch {
    throw new Error(`Invalid GATEWAY_API_URL: ${url}`);
  }
}

export const GATEWAY_API_URL = getGatewayApiUrl();
