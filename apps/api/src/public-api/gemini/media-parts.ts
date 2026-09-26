import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

export type MediaKind = "image" | "audio" | "video" | "document";

export interface MediaLimits {
  maxInlineBytesPerPart: number;
  maxInlineBytesTotal: number;
  /** When false, any fileData part is rejected before capability or size checks. */
  allowFileUris: boolean;
}

/**
 * A gs:// URI is read with the gateway's own Vertex credentials, and the
 * object's size is invisible to the hold. Off unless an operator opts in.
 */
export const FILE_DATA_DISABLED_MESSAGE =
  "fileData parts are disabled on this gateway; send the media inline.";

export interface ModelMediaCapabilities {
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsFiles: boolean;
}

export type MediaPartsCheck =
  | { ok: true; inlineBytes: number; mediaKinds: Set<MediaKind> }
  | { ok: false; message: string };

type MediaPartsFailure = Extract<MediaPartsCheck, { ok: false }>;

interface MediaCheckState {
  inlineBytes: number;
  mediaKinds: Set<MediaKind>;
}

const MEDIA_KINDS: readonly MediaKind[] = ["image", "audio", "video", "document"];
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const MEDIA_MIME_TYPES: Readonly<Record<MediaKind, readonly string[]>> = Object.freeze({
  image: Object.freeze([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  audio: Object.freeze([
    "audio/wav",
    "audio/x-wav",
    "audio/mp3",
    "audio/mpeg",
    "audio/aiff",
    "audio/aac",
    "audio/ogg",
    "audio/flac",
    "audio/webm",
  ]),
  video: Object.freeze([
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
  ]),
  document: Object.freeze(["application/pdf", "text/plain"]),
});

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaError(message: string): MediaPartsFailure {
  return { ok: false, message };
}

export function mediaKindForMimeType(mimeType: string): MediaKind | null {
  const parametersStart = mimeType.indexOf(";");
  const mediaType = parametersStart === -1 ? mimeType : mimeType.slice(0, parametersStart);
  const normalizedMimeType = mediaType.trim().toLowerCase();

  for (const kind of MEDIA_KINDS) {
    if (MEDIA_MIME_TYPES[kind].includes(normalizedMimeType)) {
      return kind;
    }
  }

  return null;
}

export function decodedBase64ByteLength(data: string): number | null {
  if (
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    return null;
  }

  const paddingBytes = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  if (
    (paddingBytes === 2 && BASE64_ALPHABET.indexOf(data[data.length - 3]!) % 16 !== 0) ||
    (paddingBytes === 1 && BASE64_ALPHABET.indexOf(data[data.length - 2]!) % 4 !== 0)
  ) {
    return null;
  }

  // Calculate size from the encoding so an oversized payload never needs a decoded copy.
  return (data.length / 4) * 3 - paddingBytes;
}

function supportsMediaKind(kind: MediaKind, capabilities: ModelMediaCapabilities): boolean {
  switch (kind) {
    case "image":
      return capabilities.supportsVision;
    case "audio":
      return capabilities.supportsAudio;
    case "video":
      return capabilities.supportsVideo;
    case "document":
      return capabilities.supportsFiles;
  }
}

function isAllowedFileUri(fileUri: string): boolean {
  try {
    const url = new URL(fileUri);

    if (url.protocol === "https:") {
      return url.hostname.length > 0;
    }

    return url.protocol === "gs:" && url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function checkMimeType(
  mimeType: unknown,
  mimeTypePath: string,
): { ok: true; kind: MediaKind } | MediaPartsFailure {
  if (typeof mimeType !== "string") {
    return mediaError(`${mimeTypePath} must be a string.`);
  }

  const kind = mediaKindForMimeType(mimeType);
  if (kind === null) {
    return mediaError(`${mimeTypePath} ${JSON.stringify(mimeType)} is not supported.`);
  }

  return { ok: true, kind };
}

function checkInlineData(
  value: unknown,
  partPath: string,
  capabilities: ModelMediaCapabilities,
  limits: MediaLimits,
  state: MediaCheckState,
): MediaPartsFailure | null {
  const inlineDataPath = `${partPath}.inlineData`;
  if (!isJsonObject(value)) {
    return mediaError(`${inlineDataPath} must be an object.`);
  }

  const mimeTypeResult = checkMimeType(value.mimeType, `${inlineDataPath}.mimeType`);
  if (!mimeTypeResult.ok) {
    return mimeTypeResult;
  }

  if (!supportsMediaKind(mimeTypeResult.kind, capabilities)) {
    return mediaError(`Model does not support ${mimeTypeResult.kind} input.`);
  }

  if (typeof value.data !== "string") {
    return mediaError(`${inlineDataPath}.data must be a string.`);
  }

  const inlineBytes = decodedBase64ByteLength(value.data);
  if (inlineBytes === null) {
    return mediaError(`${inlineDataPath}.data must be strict standard base64.`);
  }

  if (inlineBytes > limits.maxInlineBytesPerPart) {
    return mediaError(
      `${inlineDataPath}.data exceeds the per-part inline media limit of ${limits.maxInlineBytesPerPart} bytes.`,
    );
  }

  if (inlineBytes > limits.maxInlineBytesTotal - state.inlineBytes) {
    return mediaError(
      `${inlineDataPath}.data exceeds the total inline media limit of ${limits.maxInlineBytesTotal} bytes.`,
    );
  }

  state.inlineBytes += inlineBytes;
  state.mediaKinds.add(mimeTypeResult.kind);
  return null;
}

function checkFileData(
  value: unknown,
  partPath: string,
  capabilities: ModelMediaCapabilities,
  limits: MediaLimits,
  state: MediaCheckState,
): MediaPartsFailure | null {
  const fileDataPath = `${partPath}.fileData`;
  if (!limits.allowFileUris) {
    return mediaError(FILE_DATA_DISABLED_MESSAGE);
  }

  if (!isJsonObject(value)) {
    return mediaError(`${fileDataPath} must be an object.`);
  }

  if (typeof value.fileUri !== "string") {
    return mediaError(`${fileDataPath}.fileUri must be a string.`);
  }

  if (!isAllowedFileUri(value.fileUri)) {
    return mediaError(`${fileDataPath}.fileUri must be a gs://bucket/path or https:// URL.`);
  }

  const mimeTypeResult = checkMimeType(value.mimeType, `${fileDataPath}.mimeType`);
  if (!mimeTypeResult.ok) {
    return mimeTypeResult;
  }

  if (!supportsMediaKind(mimeTypeResult.kind, capabilities)) {
    return mediaError(`Model does not support ${mimeTypeResult.kind} input.`);
  }

  state.mediaKinds.add(mimeTypeResult.kind);
  return null;
}

function checkParts(
  parts: unknown[],
  parentPath: string,
  capabilities: ModelMediaCapabilities,
  limits: MediaLimits,
  state: MediaCheckState,
): MediaPartsFailure | null {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!isJsonObject(part)) {
      continue;
    }

    const partPath = `${parentPath}.parts[${index}]`;

    if (Object.hasOwn(part, "inlineData")) {
      const inlineDataResult = checkInlineData(
        part.inlineData,
        partPath,
        capabilities,
        limits,
        state,
      );
      if (inlineDataResult !== null) {
        return inlineDataResult;
      }
    }

    if (Object.hasOwn(part, "fileData")) {
      const fileDataResult = checkFileData(part.fileData, partPath, capabilities, limits, state);
      if (fileDataResult !== null) {
        return fileDataResult;
      }
    }
  }

  return null;
}

export function checkMediaParts(
  request: JsonObject,
  capabilities: ModelMediaCapabilities,
  limits: MediaLimits,
): MediaPartsCheck {
  const state: MediaCheckState = { inlineBytes: 0, mediaKinds: new Set<MediaKind>() };

  if (Array.isArray(request.contents)) {
    for (let index = 0; index < request.contents.length; index += 1) {
      const content = request.contents[index];
      if (!isJsonObject(content) || !Array.isArray(content.parts)) {
        continue;
      }

      const result = checkParts(content.parts, `contents[${index}]`, capabilities, limits, state);
      if (result !== null) {
        return result;
      }
    }
  }

  if (isJsonObject(request.systemInstruction) && Array.isArray(request.systemInstruction.parts)) {
    const result = checkParts(
      request.systemInstruction.parts,
      "systemInstruction",
      capabilities,
      limits,
      state,
    );
    if (result !== null) {
      return result;
    }
  }

  return { ok: true, inlineBytes: state.inlineBytes, mediaKinds: state.mediaKinds };
}

function visitRequestParts(
  request: JsonObject,
  visit: (part: JsonObject, partPath: string) => string | null,
): string | null {
  const groups: Array<{ parent: unknown; path: string }> = [];

  if (Array.isArray(request.contents)) {
    request.contents.forEach((content, index) => {
      groups.push({ parent: content, path: `contents[${index}]` });
    });
  }

  if (isJsonObject(request.systemInstruction)) {
    groups.push({ parent: request.systemInstruction, path: "systemInstruction" });
  }

  // embedContent carries one content object; batchEmbedContents carries requests[].content.
  if (isJsonObject(request.content)) {
    groups.push({ parent: request.content, path: "content" });
  }

  if (Array.isArray(request.requests)) {
    request.requests.forEach((item, index) => {
      if (isJsonObject(item)) {
        groups.push({ parent: item.content, path: `requests[${index}].content` });
      }
    });
  }

  for (const group of groups) {
    if (!isJsonObject(group.parent) || !Array.isArray(group.parent.parts)) {
      continue;
    }

    for (let index = 0; index < group.parent.parts.length; index += 1) {
      const part = group.parent.parts[index];
      if (!isJsonObject(part)) {
        continue;
      }

      const message = visit(part, `${group.path}.parts[${index}]`);
      if (message !== null) {
        return message;
      }
    }
  }

  return null;
}

/**
 * Rejects file URIs while they are disabled, and media parts with no MIME type,
 * on every body shape the public API forwards. Generation requests still go
 * through checkMediaParts afterwards for size and capability checks.
 */
export function mediaForwardingGate(request: JsonObject, allowFileUris: boolean): string | null {
  return visitRequestParts(request, (part, partPath) => {
    if (Object.hasOwn(part, "fileData") && !allowFileUris) {
      return FILE_DATA_DISABLED_MESSAGE;
    }

    for (const field of ["inlineData", "fileData"] as const) {
      if (!Object.hasOwn(part, field)) {
        continue;
      }

      const value = part[field];
      if (isJsonObject(value) && typeof value.mimeType !== "string") {
        return `${partPath}.${field}.mimeType must be a string.`;
      }
    }

    return null;
  });
}
