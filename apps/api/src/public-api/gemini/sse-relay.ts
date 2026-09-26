import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";
import { observeGeminiSse } from "./sse.js";

export type SseRelayOutcome = "completed" | "client_closed" | "upstream_failed" | "idle_timeout";

/** The subset of a Node writable (an Express response) the relay needs, so tests can use a fake. */
export interface SseSink {
  write(chunk: Uint8Array): boolean;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

export interface SseRelayOptions {
  idleTimeoutMs: number;
  /** Aborted when the client goes away. */
  clientSignal: AbortSignal;
  /** The upstream request's controller; the relay aborts it when it gives up on the stream. */
  upstreamAbort: AbortController;
  onEvent(event: JsonObject): void;
}

function waitForDrain(sink: SseSink, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      sink.off("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    sink.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Copies upstream SSE bytes to the client as they arrive, parsing events on the side for accounting.
 * Never throws: every way a stream can end maps to an outcome the caller settles on.
 */
export async function relaySse(
  upstream: ReadableStream<Uint8Array>,
  sink: SseSink,
  options: SseRelayOptions,
): Promise<SseRelayOutcome> {
  const reader = upstream.pipeThrough(observeGeminiSse(options.onEvent)).getReader();
  let stopReason: "client_closed" | "idle_timeout" | null = null;
  let idleTimer: NodeJS.Timeout | undefined;

  const stop = (reason: "client_closed" | "idle_timeout") => {
    if (stopReason !== null) {
      return;
    }
    stopReason = reason;
    options.upstreamAbort.abort();
    // Aborting only reaches upstreams that honour the signal; cancelling also settles a pending read.
    reader.cancel().catch(() => undefined);
  };
  const onClientAbort = () => stop("client_closed");
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle_timeout"), options.idleTimeoutMs);
  };

  if (options.clientSignal.aborted) {
    onClientAbort();
  } else {
    options.clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    armIdleTimer();
    for (;;) {
      const { done, value } = await reader.read();
      if (stopReason !== null) {
        return stopReason;
      }
      if (done) {
        return "completed";
      }

      // A slow client is not an idle upstream, so the idle clock is paused while waiting to drain.
      clearTimeout(idleTimer);
      if (!sink.write(value)) {
        await waitForDrain(sink, options.clientSignal);
      }
      if (stopReason !== null) {
        return stopReason;
      }
      armIdleTimer();
    }
  } catch {
    return stopReason ?? "upstream_failed";
  } finally {
    clearTimeout(idleTimer);
    options.clientSignal.removeEventListener("abort", onClientAbort);
  }
}

/** Mid-stream failures can no longer change the HTTP status, so they end the stream with this event. */
export function sseErrorEvent(message: string, code = 500, status = "INTERNAL"): string {
  return `data: ${JSON.stringify({ error: { code, message, status } })}\n\n`;
}
