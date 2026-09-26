import { describe, expect, it } from "vitest";

import {
  checkMediaParts,
  mediaForwardingGate,
  MEDIA_MIME_TYPES,
  type MediaKind,
  type MediaLimits,
  type ModelMediaCapabilities,
} from "./media-parts.js";
import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

const supportedCapabilities: ModelMediaCapabilities = {
  supportsVision: true,
  supportsAudio: true,
  supportsVideo: true,
  supportsFiles: true,
};

const generousLimits: MediaLimits = {
  maxInlineBytesPerPart: 1024,
  maxInlineBytesTotal: 4096,
  allowFileUris: true,
};

const mediaKinds: readonly MediaKind[] = ["image", "audio", "video", "document"];

const supportedMimeCases = mediaKinds.flatMap((kind) =>
  MEDIA_MIME_TYPES[kind].map((mimeType) => ({ kind, mimeType })),
);

function requestWithParts(parts: unknown[]): JsonObject {
  return { contents: [{ parts }] };
}

function inlinePart(mimeType: string, data = "TQ=="): JsonObject {
  return { inlineData: { mimeType, data } };
}

function filePart(mimeType?: string): JsonObject {
  const fileData: JsonObject = { fileUri: "gs://bucket/object" };
  if (mimeType !== undefined) {
    fileData.mimeType = mimeType;
  }

  return { fileData };
}

function successfulResult(
  request: JsonObject,
  capabilities = supportedCapabilities,
  limits = generousLimits,
): { ok: true; inlineBytes: number; mediaKinds: Set<MediaKind> } {
  const result = checkMediaParts(request, capabilities, limits);
  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result;
}

function encodedBytes(length: number): string {
  return Buffer.alloc(length, 1).toString("base64");
}

describe("MEDIA_MIME_TYPES", () => {
  it("is a frozen, complete allow-list", () => {
    expect(MEDIA_MIME_TYPES).toEqual({
      image: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
      audio: [
        "audio/wav",
        "audio/x-wav",
        "audio/mp3",
        "audio/mpeg",
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
      ],
      video: [
        "video/mp4",
        "video/mpeg",
        "video/mov",
        "video/quicktime",
        "video/avi",
        "video/x-flv",
        "video/mpg",
        "video/webm",
        "video/wmv",
        "video/3gpp",
      ],
      document: ["application/pdf", "text/plain"],
    });
    expect(Object.isFrozen(MEDIA_MIME_TYPES)).toBe(true);
    expect(Object.values(MEDIA_MIME_TYPES).every((mimeTypes) => Object.isFrozen(mimeTypes))).toBe(
      true,
    );
  });
});

describe("checkMediaParts", () => {
  it.each(supportedMimeCases)("accepts inline $kind MIME type $mimeType", ({ kind, mimeType }) => {
    const result = successfulResult(requestWithParts([inlinePart(mimeType)]));

    expect(result).toEqual({ ok: true, inlineBytes: 1, mediaKinds: new Set([kind]) });
  });

  it.each(supportedMimeCases)("accepts file MIME type $mimeType", ({ kind, mimeType }) => {
    const result = successfulResult(requestWithParts([filePart(mimeType)]));

    expect(result).toEqual({ ok: true, inlineBytes: 0, mediaKinds: new Set([kind]) });
  });

  it("accepts case-insensitive MIME types and ignores MIME parameters", () => {
    const result = successfulResult(
      requestWithParts([inlinePart("IMAGE/PNG; charset=binary")]),
    );

    expect(result.mediaKinds).toEqual(new Set(["image"]));
  });

  it.each([
    [
      "inline data",
      inlinePart("image/gif"),
      'contents[0].parts[0].inlineData.mimeType "image/gif" is not supported.',
    ],
    [
      "file data",
      filePart("application/json"),
      'contents[0].parts[0].fileData.mimeType "application/json" is not supported.',
    ],
  ])("rejects an unsupported MIME type in %s", (_source, part, message) => {
    const result = checkMediaParts(requestWithParts([part]), supportedCapabilities, generousLimits);

    expect(result).toEqual({ ok: false, message });
  });

  it.each([
    ["an invalid character", "T!=="],
    ["too much padding", "T==="],
    ["padding before data ends", "T=Q="],
    ["non-zero unused bits with double padding", "AB=="],
    ["non-zero unused bits with single padding", "AAB="],
    ["whitespace", "TWFuTWE\n"],
    ["a length not divisible by four", "TQ="],
  ])("rejects base64 with %s", (_description, data) => {
    const result = checkMediaParts(
      requestWithParts([inlinePart("image/png", data)]),
      supportedCapabilities,
      generousLimits,
    );

    expect(result).toEqual({
      ok: false,
      message: "contents[0].parts[0].inlineData.data must be strict standard base64.",
    });
  });

  it.each(["", "TQ==", "TWE=", "TWFu", "TWFuTQ==", "AAEC/w=="])(
    "reports the decoded byte length for %j without decoding it",
    (data) => {
      const result = successfulResult(requestWithParts([inlinePart("image/png", data)]));

      expect(result.inlineBytes).toBe(Buffer.from(data, "base64").length);
    },
  );

  it("allows inline data at the exact per-part limit", () => {
    const result = successfulResult(
      requestWithParts([inlinePart("image/png", encodedBytes(3))]),
      supportedCapabilities,
      { maxInlineBytesPerPart: 3, maxInlineBytesTotal: 3, allowFileUris: true },
    );

    expect(result.inlineBytes).toBe(3);
  });

  it("rejects inline data over the per-part limit", () => {
    const result = checkMediaParts(
      requestWithParts([inlinePart("image/png", encodedBytes(4))]),
      supportedCapabilities,
      { maxInlineBytesPerPart: 3, maxInlineBytesTotal: 4, allowFileUris: true },
    );

    expect(result).toEqual({
      ok: false,
      message:
        "contents[0].parts[0].inlineData.data exceeds the per-part inline media limit of 3 bytes.",
    });
  });

  it("allows inline data at the exact total limit", () => {
    const result = successfulResult(
      requestWithParts([
        inlinePart("image/png", encodedBytes(2)),
        inlinePart("audio/wav", encodedBytes(2)),
      ]),
      supportedCapabilities,
      { maxInlineBytesPerPart: 2, maxInlineBytesTotal: 4, allowFileUris: true },
    );

    expect(result.inlineBytes).toBe(4);
  });

  it("rejects inline data over the total limit", () => {
    const result = checkMediaParts(
      requestWithParts([
        inlinePart("image/png", encodedBytes(2)),
        inlinePart("audio/wav", encodedBytes(2)),
      ]),
      supportedCapabilities,
      { maxInlineBytesPerPart: 2, maxInlineBytesTotal: 3, allowFileUris: true },
    );

    expect(result).toEqual({
      ok: false,
      message:
        "contents[0].parts[1].inlineData.data exceeds the total inline media limit of 3 bytes.",
    });
  });

  it.each([
    ["image", "supportsVision", "image/png"],
    ["audio", "supportsAudio", "audio/wav"],
    ["video", "supportsVideo", "video/mp4"],
    ["document", "supportsFiles", "application/pdf"],
  ] as const)("rejects $0 when its model capability is disabled", (kind, capability, mimeType) => {
    const capabilities: ModelMediaCapabilities = { ...supportedCapabilities, [capability]: false };
    const result = checkMediaParts(
      requestWithParts([inlinePart(mimeType)]),
      capabilities,
      generousLimits,
    );

    expect(result).toEqual({ ok: false, message: `Model does not support ${kind} input.` });
  });

  it("applies capabilities to classified file data", () => {
    const result = checkMediaParts(
      requestWithParts([filePart("application/pdf")]),
      { ...supportedCapabilities, supportsFiles: false },
      generousLimits,
    );

    expect(result).toEqual({ ok: false, message: "Model does not support document input." });
  });

  it.each([
    ["gs://bucket/path"],
    ["https://media.example.test/object"],
  ])("accepts the file URI %s", (fileUri) => {
    const result = successfulResult(
      requestWithParts([{ fileData: { mimeType: "application/pdf", fileUri } }]),
    );

    expect(result.mediaKinds).toEqual(new Set(["document"]));
  });

  it("rejects file data without a MIME type instead of skipping the capability check", () => {
    const result = checkMediaParts(
      requestWithParts([{ fileData: { fileUri: "gs://bucket/path" } }]),
      supportedCapabilities,
      generousLimits,
    );

    expect(result).toEqual({
      ok: false,
      message: "contents[0].parts[0].fileData.mimeType must be a string.",
    });
  });

  it("rejects fileData on an embed body while file URIs are disabled", () => {
    expect(
      mediaForwardingGate(
        { content: { parts: [{ fileData: { mimeType: "audio/wav", fileUri: "gs://bucket/a" } }] } },
        false,
      ),
    ).toBe("fileData parts are disabled on this gateway; send the media inline.");
    expect(
      mediaForwardingGate(
        { requests: [{ content: { parts: [{ inlineData: { data: "TQ==" } }] } }] },
        true,
      ),
    ).toBe("requests[0].content.parts[0].inlineData.mimeType must be a string.");
  });

  it("rejects every fileData part while file URIs are disabled", () => {
    const result = checkMediaParts(
      requestWithParts([{ fileData: { mimeType: "application/pdf", fileUri: "gs://bucket/path" } }]),
      supportedCapabilities,
      { ...generousLimits, allowFileUris: false },
    );

    expect(result).toEqual({
      ok: false,
      message: "fileData parts are disabled on this gateway; send the media inline.",
    });
  });

  it.each([
    ["http://media.example.test/object"],
    ["data:text/plain,content"],
    ["file:///tmp/media"],
    ["javascript:alert(1)"],
    ["ftp://media.example.test/object"],
    ["gs://bucket"],
    ["gs:///path"],
  ])("rejects the file URI %s", (fileUri) => {
    const result = checkMediaParts(
      requestWithParts([{ fileData: { fileUri } }]),
      supportedCapabilities,
      generousLimits,
    );

    expect(result).toEqual({
      ok: false,
      message:
        "contents[0].parts[0].fileData.fileUri must be a gs://bucket/path or https:// URL.",
    });
  });

  it("walks systemInstruction parts", () => {
    const result = successfulResult({
      contents: [{ parts: [{ text: "prompt" }] }],
      systemInstruction: { parts: [inlinePart("audio/wav")] },
    });

    expect(result).toEqual({ ok: true, inlineBytes: 1, mediaKinds: new Set(["audio"]) });
  });

  it("ignores text, function, and unrelated parts without changing the request", () => {
    const request = requestWithParts([
      { text: "plain text" },
      { functionCall: { name: "lookup" } },
      { functionResponse: { name: "lookup", response: {} } },
      { futurePart: { value: true } },
    ]);
    const original = structuredClone(request);

    const result = successfulResult(request);

    expect(result).toEqual({ ok: true, inlineBytes: 0, mediaKinds: new Set() });
    expect(request).toEqual(original);
  });

  it("rejects malformed media objects with field-specific paths", () => {
    const malformedInlineData = checkMediaParts(
      requestWithParts([{ inlineData: { mimeType: "image/png" } }]),
      supportedCapabilities,
      generousLimits,
    );
    const malformedFileData = checkMediaParts(
      requestWithParts([{ fileData: { mimeType: "image/png" } }]),
      supportedCapabilities,
      generousLimits,
    );

    expect(malformedInlineData).toEqual({
      ok: false,
      message: "contents[0].parts[0].inlineData.data must be a string.",
    });
    expect(malformedFileData).toEqual({
      ok: false,
      message: "contents[0].parts[0].fileData.fileUri must be a string.",
    });
  });

  it("never includes an inline payload in errors", () => {
    const payload = "c2VjcmV0LW1lZGlhLXBheWxvYWQ=";
    const result = checkMediaParts(
      requestWithParts([inlinePart("image/gif", payload)]),
      supportedCapabilities,
      generousLimits,
    );

    expect(result).toEqual({
      ok: false,
      message: 'contents[0].parts[0].inlineData.mimeType "image/gif" is not supported.',
    });
    if (!result.ok) {
      expect(result.message).not.toContain(payload);
    }
  });
});
