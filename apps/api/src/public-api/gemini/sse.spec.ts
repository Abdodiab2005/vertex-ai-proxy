import { describe, expect, it, vi } from "vitest";

import { observeGeminiSse, SseEventParser } from "./sse.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function readChunk(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunk: Uint8Array,
): Promise<Uint8Array> {
  const pendingWrite = writer.write(chunk);
  const result = await reader.read();
  await pendingWrite;

  if (result.done || result.value === undefined) {
    throw new Error("Expected a streamed chunk.");
  }

  return result.value;
}

describe("SseEventParser", () => {
  const sample = 'data: {"sequence":1}\n\ndata: {"sequence":2}\n\n';

  it.each(Array.from({ length: bytes(sample).length + 1 }, (_, index) => index))(
    "parses a stream split at byte offset %i",
    (splitAt) => {
      const parser = new SseEventParser();
      const stream = bytes(sample);

      const events = [
        ...parser.feed(stream.slice(0, splitAt)),
        ...parser.feed(stream.slice(splitAt)),
        ...parser.flush(),
      ];

      expect(events).toEqual(['{"sequence":1}', '{"sequence":2}']);
    },
  );

  it.each([
    ["CRLF", "data: first\r\n\r\ndata: second\r\n\r\n", ["first", "second"]],
    ["multiple data lines", "data: first\ndata: second\n\n", ["first\nsecond"]],
    ["comments", ": keepalive\ndata: value\n: ignored\n\n", ["value"]],
  ] as const)("handles %s", (_name, stream, expected) => {
    const parser = new SseEventParser();
    expect(parser.feed(bytes(stream))).toEqual(expected);
  });

  it("waits for a split UTF-8 character before decoding the event", () => {
    const parser = new SseEventParser();
    const stream = bytes("data: café\n\n");
    const splitAt = Array.from(stream).indexOf(0xc3) + 1;

    expect(parser.feed(stream.slice(0, splitAt))).toEqual([]);
    expect(parser.feed(stream.slice(splitAt))).toEqual(["café"]);
  });

  it("flushes an unterminated final event", () => {
    const parser = new SseEventParser();
    expect(parser.feed(bytes("data: final"))).toEqual([]);
    expect(parser.flush()).toEqual(["final"]);
  });
});

describe("observeGeminiSse", () => {
  it("forwards each input chunk before accepting the next one and observes JSON objects", async () => {
    const onEvent = vi.fn<(event: Record<string, unknown>) => void>();
    const stream = observeGeminiSse(onEvent);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const first = bytes('data: {"sequence":1}\n\n');
    const second = bytes('data: {"sequence":2}\n\n');

    const firstOutput = await readChunk(writer, reader, first);
    expect(Array.from(firstOutput)).toEqual(Array.from(first));
    expect(decoder.decode(firstOutput)).toBe(decoder.decode(first));

    const secondOutput = await readChunk(writer, reader, second);
    expect(Array.from(secondOutput)).toEqual(Array.from(second));
    expect(decoder.decode(secondOutput)).toBe(decoder.decode(second));

    await writer.close();
    expect(onEvent).toHaveBeenNthCalledWith(1, { sequence: 1 });
    expect(onEvent).toHaveBeenNthCalledWith(2, { sequence: 2 });
  });

  it("keeps forwarding malformed JSON and observer failures", async () => {
    const onEvent = vi.fn<(event: Record<string, unknown>) => void>((event) => {
      if (event.fail === true) {
        throw new Error("observer failed");
      }
    });
    const stream = observeGeminiSse(onEvent);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const input = bytes('data: not-json\n\ndata: {"fail":true}\n\ndata: {"ok":true}\n\n');

    expect(Array.from(await readChunk(writer, reader, input))).toEqual(Array.from(input));
    await writer.close();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(2, { ok: true });
  });
});
