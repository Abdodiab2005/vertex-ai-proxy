import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Streaming boundaries can split a UTF-8 character, so decoding stays stateful. */
export class SseEventParser {
  private readonly decoder = new TextDecoder();
  private lineBuffer = "";
  private dataLines: string[] = [];
  private hasData = false;

  feed(chunk: Uint8Array): string[] {
    return this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  flush(): string[] {
    const events = this.consume(this.decoder.decode());

    if (this.lineBuffer.length > 0) {
      const line = this.trimCarriageReturn(this.lineBuffer);
      this.lineBuffer = "";
      this.processLine(line, events);
    }

    this.dispatch(events);
    return events;
  }

  private consume(text: string): string[] {
    const events: string[] = [];
    this.lineBuffer += text;

    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.trimCarriageReturn(this.lineBuffer.slice(0, newlineIndex));
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.processLine(line, events);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }

    return events;
  }

  private trimCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  private processLine(line: string, events: string[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    if (field !== "data") {
      return;
    }

    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    this.dataLines.push(value);
    this.hasData = true;
  }

  private dispatch(events: string[]): void {
    if (this.hasData) {
      events.push(this.dataLines.join("\n"));
    }

    this.dataLines = [];
    this.hasData = false;
  }
}

function observePayloads(payloads: string[], onEvent: (event: JsonObject) => void): void {
  for (const payload of payloads) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isJsonObject(parsed)) {
        onEvent(parsed);
      }
    } catch {
      // Observation cannot be allowed to interrupt the upstream response.
    }
  }
}

/** Accounting must not become a source of latency or failure for streamed bytes. */
export function observeGeminiSse(
  onEvent: (event: JsonObject) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const parser = new SseEventParser();

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      try {
        observePayloads(parser.feed(chunk), onEvent);
      } catch {
        // Upstream bytes have already been forwarded, so parser failures stay isolated.
      }
    },
    flush() {
      try {
        observePayloads(parser.flush(), onEvent);
      } catch {
        // Closing a response should not fail because its telemetry was unusable.
      }
    },
  });
}
