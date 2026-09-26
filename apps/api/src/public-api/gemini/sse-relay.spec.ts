import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";
import { relaySse, sseErrorEvent, type SseSink } from "./sse-relay.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeSink extends EventEmitter implements SseSink {
  readonly written: string[] = [];
  accepting = true;

  write(chunk: Uint8Array): boolean {
    this.written.push(decoder.decode(chunk));
    return this.accepting;
  }
}

/** An upstream the test drives by hand; it ignores abort signals like a misbehaving provider would. */
function manualUpstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: () => controller.error(new Error("boom")),
    wasCancelled: () => cancelled,
  };
}

function relayOptions(overrides: { idleTimeoutMs?: number; clientSignal?: AbortSignal } = {}) {
  const events: JsonObject[] = [];
  const upstreamAbort = new AbortController();
  return {
    events,
    upstreamAbort,
    options: {
      idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
      clientSignal: overrides.clientSignal ?? new AbortController().signal,
      upstreamAbort,
      onEvent: (event: JsonObject) => events.push(event),
    },
  };
}

describe("relaySse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards every upstream byte unchanged and reports completion", async () => {
    const upstream = manualUpstream();
    const sink = new FakeSink();
    const { options, events } = relayOptions();

    const outcome = relaySse(upstream.stream, sink, options);
    upstream.send('data: {"a":1}\n\n');
    upstream.send('data: {"usageMetadata":{"promptTokenCount":3}}\n');
    upstream.send("\n");
    upstream.close();

    await expect(outcome).resolves.toBe("completed");
    expect(sink.written.join("")).toBe('data: {"a":1}\n\ndata: {"usageMetadata":{"promptTokenCount":3}}\n\n');
    expect(events).toEqual([{ a: 1 }, { usageMetadata: { promptTokenCount: 3 } }]);
  });

  it("writes each chunk before the next one exists", async () => {
    const upstream = manualUpstream();
    const sink = new FakeSink();
    const { options } = relayOptions();

    const outcome = relaySse(upstream.stream, sink, options);
    upstream.send("data: 1\n\n");
    await vi.waitFor(() => expect(sink.written).toEqual(["data: 1\n\n"]));

    upstream.close();
    await outcome;
  });

  it("reports an upstream error as upstream_failed", async () => {
    const upstream = manualUpstream();
    const { options } = relayOptions();

    const outcome = relaySse(upstream.stream, new FakeSink(), options);
    upstream.send("data: 1\n\n");
    upstream.fail();

    await expect(outcome).resolves.toBe("upstream_failed");
  });

  it("stops on client disconnect even when the upstream ignores its abort signal", async () => {
    const upstream = manualUpstream();
    const client = new AbortController();
    const { options, upstreamAbort } = relayOptions({ clientSignal: client.signal });

    const outcome = relaySse(upstream.stream, new FakeSink(), options);
    upstream.send("data: 1\n\n");
    client.abort();

    await expect(outcome).resolves.toBe("client_closed");
    expect(upstreamAbort.signal.aborted).toBe(true);
    expect(upstream.wasCancelled()).toBe(true);
  });

  it("times out when the upstream goes quiet, resetting the clock on every chunk", async () => {
    vi.useFakeTimers();
    const upstream = manualUpstream();
    const { options, upstreamAbort } = relayOptions({ idleTimeoutMs: 1_000 });

    const outcome = relaySse(upstream.stream, new FakeSink(), options);
    await vi.advanceTimersByTimeAsync(900);
    upstream.send("data: 1\n\n");
    await vi.advanceTimersByTimeAsync(900);
    expect(upstreamAbort.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await expect(outcome).resolves.toBe("idle_timeout");
    expect(upstreamAbort.signal.aborted).toBe(true);
  });

  it("waits for drain under backpressure without counting the wait as upstream idleness", async () => {
    vi.useFakeTimers();
    const upstream = manualUpstream();
    const sink = new FakeSink();
    sink.accepting = false;
    const { options } = relayOptions({ idleTimeoutMs: 1_000 });

    const outcome = relaySse(upstream.stream, sink, options);
    upstream.send("data: 1\n\n");
    upstream.send("data: 2\n\n");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sink.written).toEqual(["data: 1\n\n"]);

    sink.accepting = true;
    sink.emit("drain");
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.written).toEqual(["data: 1\n\n", "data: 2\n\n"]);

    upstream.close();
    await expect(outcome).resolves.toBe("completed");
  });

  it("stops waiting for drain when the client disconnects", async () => {
    const upstream = manualUpstream();
    const sink = new FakeSink();
    sink.accepting = false;
    const client = new AbortController();
    const { options } = relayOptions({ clientSignal: client.signal });

    const outcome = relaySse(upstream.stream, sink, options);
    upstream.send("data: 1\n\n");
    await vi.waitFor(() => expect(sink.written).toHaveLength(1));
    client.abort();

    await expect(outcome).resolves.toBe("client_closed");
    expect(sink.listenerCount("drain")).toBe(0);
  });
});

describe("sseErrorEvent", () => {
  it("is a complete SSE event in the Gemini error shape", () => {
    expect(sseErrorEvent("Upstream stream failed.")).toBe(
      'data: {"error":{"code":500,"message":"Upstream stream failed.","status":"INTERNAL"}}\n\n',
    );
  });
});
