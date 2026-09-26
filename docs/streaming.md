# Streaming Support

The Gemini-compatible API supports Server-Sent Events (SSE) streaming for text generation.

## How it works

When a client makes a `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` request, the gateway pipes the `ReadableStream` provided by the upstream directly into the HTTP response.
To avoid latency and excessive memory usage, the gateway does not accumulate or buffer the chunks. They are delivered progressively.

### Response Headers

A successful streaming response begins with a `200 OK` status and the following headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

**Note:** The gateway explicitly avoids applying any gzip or deflate compression middleware to `text/event-stream` responses, as compression can buffer chunks and break the real-time delivery mechanism.

## Lifecycle and Billing Rules

The gateway applies the same concurrency, rate-limiting, budget, and reservation checks before starting a stream as it does for a normal unary request. Once the stream begins, the final accounting depends on how it terminates:

1. **Normal completion:**
   The stream successfully finishes. The gateway settles the usage accounting based on the last `usageMetadata` observed in the stream, with the status set to `success`: the cost is debited from the key's credit, the token counters are updated, and the concurrency slot and credit reservation are released. Settlement happens before the response ends, so by the time a client sees the end of the stream its balance and concurrency slot are already up to date.

2. **Client disconnects mid-stream:**
   If the client drops the HTTP connection while the stream is ongoing, the gateway immediately aborts the upstream request. It settles the accounting with the status `partial`, charging for the tokens reported in the last `usageMetadata` that carried counts. Vertex reports counts only on the final event, so a stream cut before it is billed from an estimate instead: the request's size and the answer text already delivered (see BILLING_AND_CREDITS.md).

3. **Upstream error mid-stream:**
   If the upstream model provider encounters an error after the stream has started, the gateway writes a final SSE error event (`data: {"error":{"code":500,"message":"Upstream stream failed.","status":"INTERNAL"}}\n\n`) to the client, closes the response, and settles the usage with status `partial` based on the last observed usage metadata.

4. **Idle timeout:**
   If the upstream stops sending bytes for longer than the `timeouts.streamIdleMs` setting (minimum 1000 ms, default 60000 ms), the gateway aborts the upstream connection and treats the condition similarly to an upstream error, writing an event with the message "Upstream stream timed out."

The request log records `partial` streams with an error code: `CANCELLED` (client disconnect), `INTERNAL` (upstream error) or `DEADLINE_EXCEEDED` (idle timeout). Its latency is the total stream duration.

A stream holds its concurrency slot and its credit reservation for its whole duration. A heartbeat every 5 minutes extends both 10-minute leases so a long stream never loses them. Unary calls and `batchEmbedContents` use the same heartbeat while they run. If the client reads slower than the upstream produces, the gateway waits for the socket to drain instead of buffering; that wait does not count towards the idle timeout.

Errors that happen before the stream opens (authentication, validation, rate limits, credit, an upstream connection error) are answered as normal Gemini JSON errors with their HTTP status. Without `?alt=sse`, the endpoint answers `400 INVALID_ARGUMENT` ("Only alt=sse streaming is supported.").

## Reverse Proxy (Nginx) Configuration

If you are running the gateway behind an Nginx reverse proxy, you must configure Nginx to allow progressive chunk delivery. Otherwise, Nginx will buffer the SSE chunks and delay delivery.

Add the following to your Nginx `location` block for the AI gateway:

```nginx
# Required for SSE streaming
proxy_buffering off;
proxy_cache off;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_read_timeout 300s; # Adjust according to expected longest generation time

# Disable gzip for SSE to avoid buffering
gzip off;
```
