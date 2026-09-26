import { ConsoleLogger } from "@nestjs/common";
import type { LoggerService, LogLevel } from "@nestjs/common";
import { getCurrentRequestId } from "./request-id.js";

export type LogFormat = "json" | "pretty";

export interface LogDestination {
  write(chunk: string): void;
}

export interface JsonLoggerOptions {
  includeStack?: boolean;
  stdout?: LogDestination;
  stderr?: LogDestination;
  clock?: () => Date;
  defaultContext?: string;
}

export interface LoggingSettings {
  LOG_FORMAT: LogFormat;
  LOG_INCLUDE_STACK: boolean;
}

export type LogMetadata = Record<string, unknown>;

export interface StructuredLogger extends LoggerService {
  logStructured(message: string, extra: LogMetadata, context?: string): void;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonLogEvent = {
  time: string;
  level: LogLevel;
  context: string;
  message: string;
  requestId?: string;
  error?: {
    name: string;
    message: string;
  };
  stack?: string;
} & Record<string, JsonValue | undefined>;

interface ParsedLogArguments {
  context?: string;
  metadata: Record<string, JsonValue>;
  error?: Error;
  stack?: string;
}

const REDACTED_METADATA_KEYS = new Set([
  "authorization",
  "body",
  "cookie",
  "headers",
  "query",
  "rawbody",
]);

const RESERVED_EVENT_KEYS = new Set([
  "context",
  "error",
  "level",
  "message",
  "requestid",
  "stack",
  "time",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const sanitized = value.flatMap((item) => {
      const result = sanitizeValue(item, seen);
      return result === undefined ? [] : [result];
    });
    seen.delete(value);
    return sanitized;
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const sanitized = sanitizeRecord(value, seen);
    seen.delete(value);
    return sanitized;
  }

  return undefined;
}

function sanitizeRecord(
  metadata: Record<string, unknown>,
  seen: WeakSet<object> = new WeakSet<object>(),
): Record<string, JsonValue> {
  const sanitized: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_METADATA_KEYS.has(key.toLowerCase())) {
      continue;
    }

    const safeValue = sanitizeValue(value, seen);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }

  return sanitized;
}

function messageFor(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null
  ) {
    return String(value);
  }

  if (isPlainRecord(value) && typeof value.message === "string") {
    return value.message;
  }

  return "Log message";
}

function isStackFormat(value: unknown): value is string {
  return typeof value === "string" && /^(.)+\n\s+at .+:\d+:\d+/.test(value);
}

function parseLogArguments(
  level: LogLevel,
  message: unknown,
  optionalParams: unknown[],
): ParsedLogArguments {
  const parameters = [...optionalParams];
  const lastParameter = parameters.at(-1);
  let context: string | undefined;
  let stack: string | undefined;

  if (
    (level === "error" || level === "fatal") &&
    parameters.length === 1 &&
    (isStackFormat(lastParameter) || lastParameter === undefined)
  ) {
    parameters.pop();
    stack = typeof lastParameter === "string" ? lastParameter : undefined;
  } else if (typeof lastParameter === "string") {
    parameters.pop();
    context = lastParameter;
  }
  const metadata: Record<string, unknown> = {};
  let error = message instanceof Error ? message : undefined;

  for (const parameter of parameters) {
    if (parameter instanceof Error && error === undefined) {
      error = parameter;
      continue;
    }

    if ((level === "error" || level === "fatal") && typeof parameter === "string" && stack === undefined) {
      stack = parameter;
      continue;
    }

    if (isPlainRecord(parameter)) {
      Object.assign(metadata, parameter);
    }
  }

  return {
    context,
    metadata: sanitizeRecord(metadata),
    error,
    stack,
  };
}

function requestIdFromMetadata(metadata: Record<string, JsonValue>): string | undefined {
  const requestId = metadata.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

/**
 * Emits only explicitly supplied, JSON-safe metadata. That keeps accidental
 * request objects from turning application logs into a content log.
 */
export class JsonLogger implements StructuredLogger {
  private readonly includeStack: boolean;
  private readonly stdout: LogDestination;
  private readonly stderr: LogDestination;
  private readonly clock: () => Date;
  private readonly defaultContext: string;
  private logLevels: ReadonlySet<LogLevel> | undefined;

  constructor(options: JsonLoggerOptions = {}) {
    this.includeStack = options.includeStack ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.clock = options.clock ?? (() => new Date());
    this.defaultContext = options.defaultContext ?? "App";
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.logLevels = new Set(levels);
  }

  logStructured(message: string, extra: LogMetadata, context?: string): void {
    const parameters: unknown[] = context === undefined ? [extra] : [extra, context];
    this.write("log", message, parameters);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (this.logLevels !== undefined && !this.logLevels.has(level)) {
      return;
    }

    const parsed = parseLogArguments(level, message, optionalParams);
    const currentRequestId = getCurrentRequestId();
    const requestId = currentRequestId ?? requestIdFromMetadata(parsed.metadata);
    const event: JsonLogEvent = {
      time: this.clock().toISOString(),
      level,
      context: parsed.context ?? this.defaultContext,
      message: messageFor(message),
    };

    if (requestId !== undefined) {
      event.requestId = requestId;
    }

    const error =
      parsed.error ??
      (level === "error" || level === "fatal"
        ? {
            name: "Error",
            message: messageFor(message),
          }
        : undefined);
    if (error !== undefined) {
      event.error = {
        name: error.name,
        message: error.message,
      };

      const stack = parsed.error?.stack ?? parsed.stack;
      if (this.includeStack && stack !== undefined) {
        event.stack = stack;
      }
    }

    for (const [key, value] of Object.entries(parsed.metadata)) {
      if (!RESERVED_EVENT_KEYS.has(key.toLowerCase())) {
        event[key] = value;
      }
    }

    const destination = level === "error" || level === "fatal" ? this.stderr : this.stdout;
    destination.write(`${JSON.stringify(event)}\n`);
  }
}

export function isStructuredLogger(logger: LoggerService): logger is StructuredLogger {
  return "logStructured" in logger && typeof logger.logStructured === "function";
}

export function createApplicationLogger(settings: LoggingSettings): LoggerService {
  if (settings.LOG_FORMAT === "pretty") {
    return new ConsoleLogger();
  }

  return new JsonLogger({ includeStack: settings.LOG_INCLUDE_STACK });
}
