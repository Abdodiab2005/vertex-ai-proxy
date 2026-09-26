# API compatibility

The public API is Gemini-shaped under `/v1beta`. The gateway authenticates
gateway keys, enforces policy, and forwards supported calls to Vertex AI.

"Tested live" means verified 2026-09-25 against real Vertex AI
(`gemini-2.5-flash`, `gemini-embedding-001`, express API key) with
`scripts/compat-smoke.mjs`, 12/12 passing. "e2e" means covered by the e2e
suite with a fake upstream.

## Endpoints

| Method | Path                                           | Notes                                                                                                                         |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1beta/models`                               | Keyset pagination (`pageSize` 1–1000, default 50; `pageToken`). Per-key model filters. Disabled / unavailable models omitted. |
| `GET`  | `/v1beta/models/{model}`                       | Public name or alias. `{model}` may be `gemini-2.5-flash` or `models/gemini-2.5-flash`.                                       |
| `POST` | `/v1beta/models/{model}:generateContent`       | JSON in, JSON out.                                                                                                            |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Requires `?alt=sse`.                                                                                                          |
| `POST` | `/v1beta/models/{model}:countTokens`           | Gemini `contents` or `generateContentRequest` forms.                                                                          |
| `POST` | `/v1beta/models/{model}:embedContent`          | Vertex `predict` or `embedContent` chosen from the upstream model id.                                                         |
| `POST` | `/v1beta/models/{model}:batchEmbedContents`    | Each item is an `embedContent` call, in order. One admission, one slot, one reservation.                                      |

Unknown `{model}:{action}` segments return `404 NOT_FOUND` "Not found."

## Auth

Supply a gateway key (`lvg_` + 32 base62 characters) as:

- header `x-goog-api-key`, or
- query `key`

If both are present, the header is used. Invalid or missing keys return
`401 UNAUTHENTICATED` "API key not valid. Please pass a valid API key."

## Request and response passthrough

- `generateContent` and `streamGenerateContent` forward the JSON object to
  Vertex after the gateway's checks. `systemInstruction`, `safetySettings`,
  `tools`, `toolConfig`, `functionCall`, and `functionResponse` are not
  rewritten. The gateway never executes tools. When the client omits
  `generationConfig.maxOutputTokens`, the gateway sets it to the output
  token count the credit hold covers (the model's `outputTokenLimit`, or 8192) so thinking and the answer share that cap. A client-supplied value
  is forwarded unchanged unless it exceeds the model's configured
  `outputTokenLimit`, in which case it is lowered to that limit.
- `cachedContent` is rejected (`400`) before the upstream is called.
- Inline media (`inlineData`) is forwarded when it passes MIME, capability,
  and size checks. `fileData` (https or `gs:` URIs) is rejected unless
  `media.allowFileUris` is on. While it is on, each `fileData` part is held
  at `media.fileUriHoldTokens` (default 50000) and still has to pass the MIME
  and capability checks. A media part with no `mimeType` is `400`.
- `countTokens` accepts Gemini's two request forms. The nested `model` field
  inside `generateContentRequest` is stripped because Vertex takes the model
  from the URL.
- `embedContent` is translated to Vertex `predict` for `gemini-embedding-001`
  and the `text-embedding-` / `text-multilingual-embedding-` families, and to
  Vertex `embedContent` for other Gemini embedding ids.
- `batchEmbedContents` sends each item through that same translation, in
  order, under one rate-limit admission, one concurrency slot, and one credit
  reservation. The reservation is the sum of the items' input-only estimates.
  One usage record (`endpoint` `batchEmbedContents`) bills the summed input
  tokens. A missing count on any item leaves the cost undetermined. An item's
  `model`, when set, must be the URL model or an alias of it (`models/<name>`
  and `<name>` are the same name). At most 100 items. A key allowed to call
  `embedContent` may call `batchEmbedContents`.
- Successful unary responses are the upstream JSON. Streaming responses are
  the upstream SSE bytes.

## Error shape

Public errors are Gemini-shaped:

```json
{
  "error": {
    "code": 400,
    "message": "…",
    "status": "INVALID_ARGUMENT"
  }
}
```

`code` equals the HTTP status. Rate-limit rejections may set `Retry-After`
(seconds). Unhandled exceptions become `500 INTERNAL` "Internal error."

### Status mapping

From `gemini-errors.ts` (`mapHttpStatusToGoogleStatus` / body-parser map),
`rate-limits-errors.ts`, and `mapUpstreamError`:

| Source                                                 | HTTP | `error.status`       | Message (when fixed)                             |
| ------------------------------------------------------ | ---- | -------------------- | ------------------------------------------------ |
| HTTP 400                                               | 400  | `INVALID_ARGUMENT`   | exception message                                |
| HTTP 401                                               | 401  | `UNAUTHENTICATED`    | exception message                                |
| HTTP 403                                               | 403  | `PERMISSION_DENIED`  | exception message                                |
| HTTP 404                                               | 404  | `NOT_FOUND`          | exception message                                |
| HTTP 429                                               | 429  | `RESOURCE_EXHAUSTED` | exception message                                |
| HTTP 503                                               | 503  | `UNAVAILABLE`        | exception message                                |
| other HTTP                                             | same | `INTERNAL`           | exception message                                |
| Body too large                                         | 413  | `INVALID_ARGUMENT`   | Request payload size exceeds the limit.          |
| Invalid JSON body                                      | 400  | `INVALID_ARGUMENT`   | Invalid JSON payload received.                   |
| Unsupported charset/encoding                           | 415  | `INVALID_ARGUMENT`   | Unsupported request encoding or charset.         |
| RPM / RPD / TPM / TPD / TPMO                           | 429  | `RESOURCE_EXHAUSTED` | `Rate limit exceeded: …`                         |
| Concurrency                                            | 429  | `RESOURCE_EXHAUSTED` | Too many concurrent requests for this API key.   |
| Upstream `authentication_failed` / `permission_denied` | 503  | `UNAVAILABLE`        | The model is temporarily unavailable.            |
| Upstream `model_unavailable`                           | 404  | `NOT_FOUND`          | The model is not found.                          |
| Upstream `quota_exhausted`                             | 429  | `RESOURCE_EXHAUSTED` | Upstream capacity exhausted. Please retry later. |
| Upstream `network_error`                               | 503  | `UNAVAILABLE`        | The model is temporarily unavailable.            |
| Upstream `upstream_error` with HTTP 400                | 400  | `INVALID_ARGUMENT`   | upstream message                                 |
| Other `upstream_error`                                 | 502  | `UNAVAILABLE`        | An error occurred with the upstream provider.    |

Direct `GeminiApiException` statuses used on this path also include
`FAILED_PRECONDITION` (no pricing) and the availability / credit messages in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

Pre-stream failures (auth, validation, limits, credit, connect) stay JSON
with the HTTP status. After SSE headers, failures are a final `data:
{"error":…}` event.

## Limits

| Limit                   | Value                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public JSON body        | `PUBLIC_MAX_REQUEST_BODY_BYTES`, default 20 MiB (20,971,520).                                                                                                                                                 |
| Admin / other JSON body | `ADMIN_MAX_REQUEST_BODY_BYTES`, default 1 MiB.                                                                                                                                                                |
| Decoded inline media    | setting `media.maxInlineBytes`, default 15 MiB, applied per part and as a request total.                                                                                                                      |
| File URIs (`fileData`)  | off unless `media.allowFileUris` is true. When on, each part reserves `media.fileUriHoldTokens` (default 50000, min 1000, max 2000000).                                                                       |
| MIME types              | image: png, jpeg, webp, heic, heif; audio: wav, x-wav, mp3, mpeg, aiff, aac, ogg, flac, webm; video: mp4, mpeg, mov, quicktime, avi, x-flv, mpg, webm, wmv, 3gpp; documents: `application/pdf`, `text/plain`. |

Inline data must be strict standard base64. Oversized or malformed media is
`400 INVALID_ARGUMENT` before rate limits, concurrency, or credit.

## Compatibility matrix

| Feature                                                             | Status                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| models.list                                                         | Supported — tested live + e2e                                                                   |
| models.get                                                          | Supported — tested live + e2e                                                                   |
| generateContent                                                     | Supported — tested live + e2e                                                                   |
| streamGenerateContent (alt=sse)                                     | Supported — tested live (9 events over ~1.9 s) + e2e progressive delivery                       |
| streamGenerateContent without alt=sse                               | Unsupported (400 INVALID_ARGUMENT)                                                              |
| countTokens                                                         | Supported — tested live + e2e (not billed)                                                      |
| embedContent                                                        | Supported — tested live (3072 dims) + e2e                                                       |
| batchEmbedContents                                                  | Supported — tested live (through the official SDK's embedContent) + e2e                         |
| text                                                                | Supported — tested live                                                                         |
| image input (inlineData)                                            | Supported — tested live (PNG) + e2e validation                                                  |
| audio input (inlineData)                                            | Supported — tested live (WAV) + e2e validation                                                  |
| video input                                                         | Passed through when the model is marked supportsVideo; not verified live                        |
| PDF / documents                                                     | Passed through when the model is marked supportsFiles; not verified live                        |
| fileData (URIs)                                                     | Rejected unless `media.allowFileUris` is on; then the same capability checks. Not verified live |
| function calling (tools, toolConfig, functionCall/functionResponse) | Supported — tested live round trip; the gateway never executes tools                            |
| systemInstruction                                                   | Supported — tested live                                                                         |
| generationConfig                                                    | Supported — tested live                                                                         |
| safetySettings                                                      | Accepted and forwarded — tested live (request succeeds); blocking behaviour not verified        |
| query-key auth (?key=)                                              | Supported — tested live                                                                         |
| Files API                                                           | Unsupported                                                                                     |
| Live API                                                            | Unsupported                                                                                     |
| cachedContents                                                      | Unsupported                                                                                     |
| tunedModels                                                         | Unsupported                                                                                     |

## Official SDKs

The official `@google/genai` JavaScript SDK (2.24.0) was run against the gateway on 2026-09-25 with
only `httpOptions.baseUrl` and the API key changed: `models.list`, `models.get`, `generateContent`,
`generateContentStream`, `countTokens`, `embedContent` (which the SDK sends as
`batchEmbedContents`), function calling, and the invalid-key error all worked against real Vertex.
The Python `google-genai` SDK (2.25.0) was run the same way, with only
`http_options=types.HttpOptions(base_url=...)` and the API key set: `models.list`, `models.get`,
`generate_content`, `generate_content_stream`, `count_tokens`, `embed_content` with two inputs, and
function calling all worked against real Vertex.

Pay-as-you-go Vertex traffic shares capacity per model (Dynamic Shared Quota). When it runs short,
Vertex answers `429 "Resource exhausted. Please try again later."` at random, more often for new
models; observed on 2026-09-26 as 2 of 10 parallel requests to `gemini-3.7-flash`. Google doesn't
bill these and asks for retries with backoff, so the gateway retries the same upstream after about
1 s, 2 s and 4 s (±25% jitter) before any byte reaches the client, and stops if the client leaves.
A connection to Vertex that could not be established (for example a TCP connect timeout in a burst) is retried the same way, since that request never left the gateway. Only if every retry fails does the client get `429 RESOURCE_EXHAUSTED` ("Upstream capacity
exhausted"), which both SDKs surface as a normal API error.

## Verified rejections

From `apps/api/test/compat-rejections.e2e-spec.ts`. Each case uses the Gemini
error shape. Unless noted, the fake upstream is not called. Unary
`generateContent` and `streamGenerateContent?alt=sse` both answer JSON (not
SSE) for these errors:

| Condition                                             | HTTP | `status`             | Message                                                                                  |
| ----------------------------------------------------- | ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| Invalid key                                           | 401  | `UNAUTHENTICATED`    | API key not valid. Please pass a valid API key.                                          |
| Revoked key                                           | 403  | `PERMISSION_DENIED`  | API key has been revoked.                                                                |
| Expired key                                           | 403  | `PERMISSION_DENIED`  | API key has expired.                                                                     |
| Suspended key                                         | 403  | `PERMISSION_DENIED`  | API key is suspended.                                                                    |
| Credit exhausted                                      | 429  | `RESOURCE_EXHAUSTED` | API key credit has been exhausted.                                                       |
| Requests per minute = 1 (second call)                 | 429  | `RESOURCE_EXHAUSTED` | Rate limit exceeded: requests per minute. (`Retry-After` is a positive integer.)         |
| Max concurrent requests = 1 (second overlapping call) | 429  | `RESOURCE_EXHAUSTED` | Too many concurrent requests for this API key.                                           |
| Disabled model                                        | 404  | `NOT_FOUND`          | `Model {name} is not found.`                                                             |
| Model not on the key allow-list                       | 403  | `PERMISSION_DENIED`  | `This API key is not allowed to use model {name}.`                                       |
| Kill switch on                                        | 503  | `UNAVAILABLE`        | The gateway is temporarily disabled.                                                     |
| Upstream `network_error`                              | 503  | `UNAVAILABLE`        | The model is temporarily unavailable. (upstream detail such as `ECONNRESET` is omitted.) |
| Upstream `authentication_failed`                      | 503  | `UNAVAILABLE`        | The model is temporarily unavailable. (credential text is omitted.)                      |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the request pipeline and
[`../README.md`](../README.md) for curl examples.
