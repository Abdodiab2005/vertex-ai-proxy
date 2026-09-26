import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RequestLog } from "@gateway/database";

export interface RequestLogEntry {
  requestId: string;
  apiKeyId: string | null;
  model: string | null;
  endpoint: string;
  status: string;
  latencyMs: number | null;
  inputTokens: string | null;
  outputTokens: string | null;
  otherUsageDimensions: Record<string, unknown> | null;
  calculatedCost: string | null;
  clientIp: string | null;
  userAgent: string | null;
  upstream: string | null;
  errorCode: string | null;
}

@Injectable()
export class RequestLogService {
  private readonly logger = new Logger(RequestLogService.name);

  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogs: Repository<RequestLog>,
  ) {}

  /**
   * Records a request log entry.
   *
   * This method NEVER throws into the caller. Logging failures are
   * swallowed with a warning so that a logging error cannot fail a
   * client request. The entry contains ONLY metadata fields — there
   * is no field that could carry prompt/response content.
   *
   * userAgent is truncated to 512 characters. A null clientIp is allowed.
   */
  async record(entry: RequestLogEntry): Promise<void> {
    try {
      const userAgent = entry.userAgent
        ? entry.userAgent.slice(0, 512)
        : entry.userAgent;

      const row = {
        requestId: entry.requestId,
        apiKeyId: entry.apiKeyId,
        model: entry.model,
        endpoint: entry.endpoint,
        status: entry.status,
        latencyMs: entry.latencyMs,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        otherUsageDimensions: entry.otherUsageDimensions as unknown as Record<string, unknown> | null,
        calculatedCost: entry.calculatedCost,
        clientIp: entry.clientIp,
        userAgent,
        upstream: entry.upstream,
        errorCode: entry.errorCode,
      };

      await this.requestLogs.insert(row as object);
    } catch (error) {
      // Swallow the error: logging failure must not fail the request.
      // Log a warning so operators can observe logging issues.
      this.logger.warn(
        `Failed to record request log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}