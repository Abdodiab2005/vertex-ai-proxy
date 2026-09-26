# Billing and credits

Each gateway API key has its own prepaid balance. The balance is the sum of
`credit_transactions`. Public generation is refused when the remaining
balance cannot cover a new hold.

## Ledger

Table `credit_transactions` is append-only: a trigger rejects `UPDATE` and
`DELETE`. A `CHECK` constraint enforces sign by type. Amounts are Postgres
`numeric(18, 6)` and TypeScript `string`. Arithmetic uses integer micro-units
(`1.000000` → `1000000n`).

| Type                | Sign     | Who writes it                                                            |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| `credit_added`      | positive | Admin add, initial credit on key create                                  |
| `credit_removed`    | negative | Admin remove (UI sends a positive magnitude; the API stores it negative) |
| `cost_consumed`     | ≤ 0      | Settlement debit for a priced request                                    |
| `refund`            | positive | Admin refund                                                             |
| `manual_adjustment` | non-zero | Admin signed adjustment                                                  |

Remaining credit is `SUM(amount)`. When remaining goes to zero the key status
becomes `credit_exhausted`; a later add flips it back to `active`.

## How a request is billed

Billed actions: `generateContent`, `streamGenerateContent`, `embedContent`,
`batchEmbedContents`. `countTokens` is recorded at zero cost (no reservation,
no debit).

### Reservation estimate

From `reservation-estimate.ts`. Policy constants: 3 characters per estimated
text token, a 1000-token floor per inline media part, default max output 8192. Each `fileData` part, when file URIs are allowed, reserves
`media.fileUriHoldTokens` (default 50000).

Input tokens = text in `contents` and `systemInstruction` (`ceil(charCount /
3)`) + inline media + tool `functionDeclarations` serialized as JSON and
counted as text. `embedContent` is estimated from `embedReservationBody`
(the item's `content` wrapped as `contents`), the same shape each
`batchEmbedContents` item uses. The input rule is the one
`selectEffectiveRules` returns at request start; a closed or not-yet-effective
rule does not price the hold.

Inline media is `max(floor, ceil(decodedBytes / bytesPerToken))` using
`INLINE_MEDIA_BYTES_PER_TOKEN`: audio 500, video 200, documents (PDF and
`text/plain`) 200, images 1000. Those ratios are conservative for compressed
media. A part the estimator cannot size stays at the 1000-token floor.

Output tokens = `generationConfig.maxOutputTokens` when set, capped by the
model's `outputTokenLimit`, else that limit, else 8192. When the client
omits `maxOutputTokens`, the body sent upstream has it set to that same
count, so thinking tokens and the answer share the cap the hold priced. A
client-supplied value is forwarded unchanged when it fits the hold, and lowered
to the hold's output tokens when it asks for more than the model's configured
`outputTokenLimit`.

Line cost in micros: `ceil(tokens × price × 10^8 / (unitSize × 100))` using
the same 8-decimal price encoding as the engine.

Generation estimate = input line (`input_tokens` rule) + output line. The
output line uses the higher per-token price of `output_tokens` and
`reasoning_tokens`. An unpriced `reasoning_tokens` dimension falls back to
the output price. Embeddings use the effective `input_tokens` rule only.
Missing required rules → `400 FAILED_PRECONDITION`.

### Concurrent reservation

From `reservation-decision.ts` (mirrored in the Redis Lua reserve script).
`available = balance − activeReservations`.

- `available ≤ 0` → refuse.
- `estimate ≤ available` → hold `estimate`.
- `estimate > available` and other holds exist → refuse (concurrent requests
  must not share the same remaining money).
- `estimate > available` and no other holds → hold `available`. A lone
  request may finish above the hold; overspend is at most that one request.

Holds live in Redis (`credit:zset:` / `credit:hash:`) with a 10-minute lease.
A heartbeat every half lease extends that hold and the concurrency slot for
as long as a stream, a unary call, or `batchEmbedContents` is running. A
crashed process stops heartbeating, so the hold still expires within one lease.

The balance passed into reserve is a snapshot. After the hold is stored, the
gateway reads remaining credit again and requires
`activeReservedMicros` (which now includes this hold) ≤ that balance. A
settlement that debited and released between the two reads would otherwise
leave the new hold spending money that is already gone. The lone-request
clamp still fits, because that hold is whatever balance remained. If the
re-check fails, the hold is released and the request is `429` "API key
credit has been exhausted."

### Settlement

After the upstream returns (or a stream ends), `usageQuantitiesFromMetadata`
reads `usageMetadata`. `calculateCost` prices those quantities with the
rules that were effective at request start. `UsageAccountingService`:

- Writes `usage_records` (quantities, snapshot, latency).
- Debits `cost_consumed` when `usageComplete` is true, every dimension was
  priced, and `total` is greater than zero. The ledger amount is
  `-{total}`.
- Always releases the Redis reservation.

`x-request-id` is the `request_id` on the usage row.

## Billing dimensions

Known dimensions: `input_tokens`, `output_tokens`, `cached_input_tokens`,
`reasoning_tokens`, `audio_input_tokens`, `audio_output_tokens`,
`image_output_tokens`, `image_units`. From `gemini/usage.ts`, to avoid billing a token twice:

| Dimension             | Source                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `cached_input_tokens` | `cachedContentTokenCount`                                             |
| `audio_input_tokens`  | `AUDIO` entries in `promptTokensDetails`                              |
| `audio_output_tokens` | `AUDIO` entries in `candidatesTokensDetails`                          |
| `image_output_tokens` | `IMAGE` entries in `candidatesTokensDetails` (generated images)       |
| `reasoning_tokens`    | `thoughtsTokenCount`                                                  |
| `input_tokens`        | `promptTokenCount` + `toolUsePromptTokenCount` − cached − input audio |
| `output_tokens`       | `candidatesTokenCount` − output audio − output images                 |

Zero and absent optional counts are treated as zero. An absent
`promptTokenCount` makes usage incomplete. An absent `candidatesTokenCount`
is zero output. `embedContent` bills `input_tokens` from the provider's
reported input tokens when present. `batchEmbedContents` writes one usage
record whose `input_tokens` is the sum of the items' counts. A missing count
on any item leaves that record's cost undetermined.

## Per-line rounding

From `pricing-engine.ts`. Each line is `quantity × price / unitSize` in
fixed-point at 10^8, then converted to 6 fractional digits with **round
half-up**: `(costScaled8 + 50n) / 100n`. Zero quantities produce no line.
The total is the sum of those 6-decimal lines.

A token dimension without a rule of its own is billed at a base token price, so
a missing rule never makes usage free: `reasoning_tokens` and
`audio_output_tokens` at the `output_tokens` price (Google bills thinking as
output), `audio_input_tokens` and `cached_input_tokens` at the `input_tokens`
price. Such a line records `pricedAs` in the snapshot. Add an explicit rule for
the exact price (audio input costs more than text on Vertex; cached input
costs less). Dimensions with neither their own rule nor a fallback are listed
as `unpricedDimensions`.

`image_output_tokens` has no fallback on purpose: Vertex bills generated images
at 10–40× the text output rate (Nano Banana 2 Lite $30, Nano Banana 2 $60,
Nano Banana Pro $120 per 1M tokens; a 1K image is 1,120 tokens), so no other
price is a safe stand-in. Input images stay in `input_tokens` at the input
price. A request that asks for images (`generationConfig.responseModalities`
includes `IMAGE`) on a model with no effective `image_output_tokens` rule is
refused with `400 FAILED_PRECONDITION` before anything is spent, and the credit
hold's output part is priced at the highest of the output, reasoning and image
output rates.

### Worked example

Model `gemini-2.5-flash`. Rules per 1,000,000 tokens: input `$0.30`, output
`$2.50`, reasoning `$2.50`. Usage: 5 input, 2 output, 14 reasoning tokens.

| Dimension          | Quantity | Arithmetic                         | Line after half-up to 6 dp |
| ------------------ | -------- | ---------------------------------- | -------------------------- |
| `input_tokens`     | 5        | `5 × 0.30 / 1_000_000 = 0.0000015` | `0.000002`                 |
| `output_tokens`    | 2        | `2 × 2.50 / 1_000_000 = 0.000005`  | `0.000005`                 |
| `reasoning_tokens` | 14       | `14 × 2.50 / 1_000_000 = 0.000035` | `0.000035`                 |
| **total**          |          |                                    | **`0.000042`**             |

## Unknown usage metadata

If `usageMetadata` is missing or malformed, quantities are empty or
`usageComplete` is false, and the usage row is stored with
`cost_undetermined = true`. The gateway does not invent token counts. Whatever
was priced is still debited as a lower bound (a partial count, or a response
with an unpriced dimension); with nothing priced at all, `calculated_cost` is
null and nothing is debited. The reservation is released either way.

## Failed requests

If no upstream performed billable work (auth, validation, limits, credit,
connect failure, retryable fallback that never answered), there is no usage
row; the reservation is released.

If the client cancels after the request was sent (`abortedInFlight`), a usage
row is kept for that upstream with cost undetermined, because Vertex may
still have billed the call.

## Streaming partial billing

A completed stream settles as `success` from the last `usageMetadata` in the
SSE. Client disconnect, upstream error, and idle timeout settle as `partial`
from the last metadata that carried token counts.

Vertex puts token counts only on the final event (earlier events carry just
`trafficType`), so a stream cut before it has no counts at all. It is then
billed from what the gateway saw: the request's estimated input tokens (the
reservation's chars-per-token rule) and the answer text already delivered to
the client (characters ÷ 3), at the input and output prices. The usage row's
token columns stay empty, `cost_undetermined` is true, and the pricing snapshot
records the estimate under `estimate`. See [`streaming.md`](./streaming.md).

## Pricing changes

Rules are effective-dated `[effectiveFrom, effectiveTo)`. Adding a rule
closes the previous open rule for that dimension at the new `effectiveFrom`.
Overlaps are rejected. `effectiveFrom` may be at most 60 seconds in the past.
Each usage row stores a snapshot of the rules (and lines) used; later price
edits do not change historical cost. `calculateCostFromSnapshot` recomputes
from that snapshot.

## Admin credit operations

On the key detail page, or `POST /admin/api-keys/:id/credits`:

- `credit_added` — positive amount; description optional.
- `credit_removed` — positive amount in the request; stored negative;
  description required.
- `refund` — positive; description required.
- `manual_adjustment` — non-zero signed amount; description required.

Key create may grant `initialCredit` or the `keys.defaultInitialCredit`
setting when that amount is positive. Regenerating a key keeps the same row:
balance, ledger, usage, and limits. Bulk create assigns independent balances
in one transaction.

## Spend guard

Settings `spend.upstreamBudget`, `spend.safetyReserve` (default `"0"`), and
`spend.blockWhenThresholdReached` (default off). Tracked spend is
`-SUM(amount)` of `cost_consumed` rows, labeled "Gateway tracked / estimated
upstream spend". Usable target is budget − reserve. When blocking is on and
tracked spend ≥ that target, new billed requests return `503 UNAVAILABLE`
"The gateway's spending limit has been reached." This is an operator
estimate of remaining Google Cloud credit. It is not Google Cloud's
authoritative billing balance.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`../README.md`](../README.md).
