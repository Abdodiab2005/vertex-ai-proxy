import { Injectable, Logger } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { InjectEntityManager } from "@nestjs/typeorm";
import { EntityManager } from "typeorm";

import type { ApiKey } from "@gateway/database";
import { ModelAlias, PricingRule } from "@gateway/database";

import { ModelResolver, type ResolvedModel } from "../models/model-resolver.js";
import { GeminiApiException } from "./gemini-errors.js";
import { embedReservationBody, parseBatchEmbedRequests } from "./gemini/batch-embed.js";
import { checkGenerateContentRequest, requestsImageOutput, withReservedOutputCap } from "./gemini/generate-content-request.js";
import { checkMediaParts, mediaForwardingGate } from "./gemini/media-parts.js";
import { usageQuantitiesFromMetadata } from "./gemini/usage.js";
import { UpstreamProviderFactory } from "../upstreams/upstream-provider.factory.js";
import { isAbortedInFlight, UpstreamError, UpstreamInputError } from "../upstreams/providers/upstream-errors.js";
import type { AIUpstreamProvider, JsonObject } from "../upstreams/providers/upstream-provider.js";
import { CreditLedgerService } from "../credits/credit-ledger.service.js";
import { CreditReservationStore } from "../credits/credit-reservation.store.js";
import { UsageAccountingService } from "../credits/usage-accounting.service.js";
import { RequestLimiter, ConcurrencyLimiter, toRateLimitException, ConcurrencySlot } from "../rate-limits/index.js";
import { SpendGuardService } from "../settings/spend-guard.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { RequestLogService } from "../request-logs/request-log.service.js";
import { assertModelAllowed } from "../api-keys/api-key-auth.guard.js";
import { calculateCost, PricingConfigurationError, selectEffectiveRules } from "../pricing/pricing-engine.js";
import type { CostBreakdown } from "../pricing/pricing-engine.js";
import { holdsFitFreshBalance } from "../credits/reservation-decision.js";
import {
  estimateInputOnlyReservationMicros,
  estimateInputTokens,
  estimateOutputTokens,
  estimateReservationMicros,
  type ReservationPolicy,
} from "../credits/reservation-estimate.js";
import type { Upstream } from "@gateway/database";
import { RedisService } from "../redis/redis.service.js";
import {
  isRetryableFailure,
  isRetryableOnSameUpstream,
  jittered,
  maxAttempts,
  planRoute,
  quotaRetryDelays,
  sleepUnlessAborted
} from "../routing/index.js";
import { MetricsRegistry } from "../metrics/metrics.registry.js";
import { StreamObservation } from "./gemini/stream-observation.js";
import { relaySse, sseErrorEvent, type SseRelayOutcome } from "./gemini/sse-relay.js";
import { GatewayShutdownError } from "../lifecycle/in-flight-requests.js";

/** Concurrency slots and credit reservations outlive a crashed process by at most this long. */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

let leaseMsOverride: number | null = null;

export function currentLeaseMs(): number {
  return leaseMsOverride ?? DEFAULT_LEASE_MS;
}

/** A short lease lets tests observe renewal without waiting out the production lease. */
export function setLeaseMsForTests(leaseMs: number | null): void {
  leaseMsOverride = leaseMs;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Preparation {
  resolved: ResolvedModel;
  /** The upstreams to try, in order; fallback may move past the first only on a retryable failure. */
  attempts: Upstream[];
  concurrencySlot: ConcurrencySlot;
  reservationId: string | null;
  requestStartedAt: Date;
  rules: PricingRule[];
  jsonBody: JsonObject;
  isEmbed: boolean;
  /**
   * Mapped embed bodies for batchEmbedContents, so the reservation and the upstream
   * calls share one parse. Null for every other action.
   */
  batchEmbedRequests: JsonObject[] | null;
}

@Injectable()
export class PublicGenerationService {
  private readonly logger = new Logger(PublicGenerationService.name);

  constructor(
    private readonly modelResolver: ModelResolver,
    private readonly upstreams: UpstreamProviderFactory,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditReservation: CreditReservationStore,
    private readonly usageAccounting: UsageAccountingService,
    private readonly requestLimiter: RequestLimiter,
    private readonly concurrencyLimiter: ConcurrencyLimiter,
    private readonly spendGuard: SpendGuardService,
    private readonly settings: SettingsService,
    private readonly requestLogs: RequestLogService,
    private readonly metrics: MetricsRegistry,
    private readonly redis: RedisService,
    @InjectEntityManager() private readonly manager: EntityManager
  ) {}

  private async prepare(
    apiKey: ApiKey,
    modelName: string,
    action: string,
    body: unknown
  ): Promise<Preparation> {
    const requestStartedAt = new Date();

    if (!isJsonObject(body)) {
      throw new GeminiApiException(400, "INVALID_ARGUMENT", "Request body must be a JSON object.");
    }

    let jsonBody: JsonObject = body;

    if (action === "generateContent" || action === "streamGenerateContent") {
      const checkResult = checkGenerateContentRequest(jsonBody);
      if (!checkResult.ok) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", checkResult.message);
      }
    }

    const resolved = await this.modelResolver.resolve(modelName);
    if (!resolved) {
      throw new GeminiApiException(404, "NOT_FOUND", `Model ${modelName} is not found.`);
    }
    assertModelAllowed(
      apiKey,
      [resolved.model.publicName, ...(resolved.aliases ?? [])],
      modelName,
    );

    if (action === "generateContent" || action === "countTokens" || action === "streamGenerateContent") {
      if (!resolved.model.supportsText) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", `Model ${resolved.model.publicName} does not support ${action}.`);
      }
      if (action === "streamGenerateContent" && !resolved.model.supportsStreaming) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", `Model ${resolved.model.publicName} does not support streaming.`);
      }
    } else if (action === "embedContent" || action === "batchEmbedContents") {
      if (!resolved.model.supportsEmbeddings) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", `Model ${resolved.model.publicName} does not support ${action}.`);
      }
    }

    let batchEmbedRequests: JsonObject[] | null = null;
    if (action === "batchEmbedContents") {
      const aliasRows = await this.manager.find(ModelAlias, { where: { modelId: resolved.model.id } });
      // The URL may name an alias. Compare against the public name and every alias of that model.
      const equivalentNames = new Set<string>([
        resolved.model.publicName,
        ...aliasRows.map((row) => row.alias),
      ]);
      const parsed = parseBatchEmbedRequests(jsonBody, modelName, equivalentNames);
      if (!parsed.ok) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", parsed.message);
      }
      batchEmbedRequests = parsed.requests;
    }

    const allowFileUris = await this.settings.get("media.allowFileUris");
    const mediaGate = mediaForwardingGate(jsonBody, allowFileUris);
    if (mediaGate !== null) {
      throw new GeminiApiException(400, "INVALID_ARGUMENT", mediaGate);
    }

    if (action === "generateContent" || action === "streamGenerateContent" || action === "countTokens") {
      // Checked before any limit is spent: a part the model can't read, a MIME type Vertex doesn't
      // accept, or oversized inline data would otherwise fail upstream after a reservation.
      const maxInlineBytes = await this.numberSetting("media.maxInlineBytes", 15 * 1024 * 1024);
      const media = checkMediaParts(jsonBody, resolved.model, {
        maxInlineBytesPerPart: maxInlineBytes,
        maxInlineBytesTotal: maxInlineBytes,
        allowFileUris,
      });
      if (!media.ok) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", media.message);
      }
    }

    const attempts = await this.planAttempts(resolved);

    const admitResult = await this.requestLimiter.admitRequest(apiKey.id, {
      ...apiKey
    });
    if (!admitResult.allowed) {
      this.metrics.incrementRateLimitRejection(admitResult.limit);
      throw toRateLimitException(admitResult);
    }

    const concurrencyResult = await this.concurrencyLimiter.acquire(apiKey.id, apiKey.maxConcurrentRequests, currentLeaseMs());
    if (concurrencyResult.acquired === false) {
      this.metrics.incrementRateLimitRejection("concurrency");
      throw toRateLimitException(concurrencyResult);
    }
    const concurrencySlot = concurrencyResult.slot;

    const requiresBilling =
      action === "generateContent" ||
      action === "embedContent" ||
      action === "batchEmbedContents" ||
      action === "streamGenerateContent";
    let rules: PricingRule[] = [];
    let reservationId: string | null = null;
    const isEmbed = action === "embedContent" || action === "batchEmbedContents";

    if (requiresBilling) {
      try {
        const policy = await this.reservationPolicy();
        if (!isEmbed) {
          jsonBody = withReservedOutputCap(
            jsonBody,
            estimateOutputTokens(jsonBody, resolved.model.outputTokenLimit, policy),
          );
        }

        rules = await this.manager.find(PricingRule, { where: { modelId: resolved.model.id } });
        const rulesInput = rules.map(r => ({
          id: r.id,
          billingDimension: r.billingDimension,
          unitSize: r.unitSize,
          price: r.price,
          currency: r.currency,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
        }));

        let estimateMicros = 0n;
        if (isEmbed) {
          const inputRule = selectEffectiveRules(rulesInput, requestStartedAt).get("input_tokens");
          if (!inputRule) {
            throw new GeminiApiException(400, "FAILED_PRECONDITION", `Model ${resolved.model.publicName} has no pricing configured.`);
          }
          // One hold for the whole call. A single embed's raw body has `content`,
          // not `contents`; batch items are the same shape.
          const embedBodies = batchEmbedRequests === null ? [jsonBody] : batchEmbedRequests;
          for (const item of embedBodies) {
            estimateMicros += estimateInputOnlyReservationMicros(
              embedReservationBody(item),
              inputRule,
              policy,
            );
          }
        } else {
          const estimate = estimateReservationMicros({
            request: jsonBody,
            rules: rulesInput,
            at: requestStartedAt,
            modelOutputTokenLimit: resolved.model.outputTokenLimit,
            policy,
          });
          if (!estimate.priced) {
            throw new GeminiApiException(400, "FAILED_PRECONDITION", `Model ${resolved.model.publicName} has no pricing configured.`);
          }
          // Generated images cost many times text output, and nothing else is a safe stand-in for
          // their price, so a model must price them before it is asked for them.
          if (requestsImageOutput(jsonBody) && !selectEffectiveRules(rulesInput, requestStartedAt).has("image_output_tokens")) {
            throw new GeminiApiException(
              400,
              "FAILED_PRECONDITION",
              `Model ${resolved.model.publicName} has no image output pricing configured.`
            );
          }
          estimateMicros = estimate.micros;
        }

        await this.spendGuard.assertWithinBudget();

        const balance = await this.creditLedger.remainingMicros(apiKey.id, this.manager);
        const reserveResult = await this.creditReservation.reserve(apiKey.id, balance, estimateMicros, currentLeaseMs());
        if (!reserveResult.allowed) {
          this.metrics.incrementCreditRejection();
          throw new GeminiApiException(429, "RESOURCE_EXHAUSTED", "API key credit has been exhausted.");
        }

        // The balance passed to reserve is a snapshot. A request that settles
        // in between debits the ledger and releases its hold, so the reserve
        // would otherwise treat that money as still available.
        const freshBalance = await this.creditLedger.remainingMicros(apiKey.id, this.manager);
        const activeReserved = await this.creditReservation.activeReservedMicros(apiKey.id);
        if (!holdsFitFreshBalance(activeReserved, freshBalance)) {
          await this.creditReservation.release(apiKey.id, reserveResult.reservationId);
          this.metrics.incrementCreditRejection();
          throw new GeminiApiException(429, "RESOURCE_EXHAUSTED", "API key credit has been exhausted.");
        }
        reservationId = reserveResult.reservationId;
      } catch (error) {
        await concurrencySlot.release().catch(e => this.logger.error(`Failed to release concurrency slot:`, e));
        throw error;
      }
    }

    return {
      resolved,
      attempts,
      concurrencySlot,
      reservationId,
      requestStartedAt,
      rules,
      jsonBody,
      isEmbed,
      batchEmbedRequests,
    };
  }

  private async settle(opts: {
    apiKey: ApiKey;
    action: string;
    requestId: string;
    req: Request;
    finalStatus: string;
    errorCode: string | null;
    latencyMs: number | null;
    quantities: Record<string, string | number | bigint>;
    usageComplete: boolean;
    breakdown: CostBreakdown | null;
    prep: Preparation | null;
    /**
     * The upstream the usage record is charged to: the one that answered, or the one a request was
     * cancelled in flight on (it may have been billed, so the record stays, cost undetermined).
     * Null means no upstream did billable work and only the reservation is released.
     */
    usageUpstream: Upstream | null;
    /** The last upstream tried, for the request log. */
    logUpstream: Upstream | null;
  }) {
    const { apiKey, action, requestId, req, finalStatus, errorCode, latencyMs, quantities, usageComplete, breakdown, prep, usageUpstream, logUpstream } = opts;

    if (usageUpstream && prep) {
      try {
        await this.usageAccounting.settle({
          requestId,
          apiKeyId: apiKey.id,
          modelId: prep.resolved.model.id,
          upstreamId: usageUpstream.id,
          endpoint: action,
          status: finalStatus,
          latencyMs,
          quantities,
          usageComplete,
          breakdown: breakdown ? { ...breakdown, lines: breakdown.lines as unknown as Record<string, unknown>[], snapshot: breakdown.snapshot as unknown as Record<string, unknown> } : null,
          reservation: prep.reservationId ? { reservationId: prep.reservationId } : null,
        });

        if (finalStatus === "success" || finalStatus === "partial") {
          if (action !== "countTokens") {
            let totalTokens = 0;
            for (const [key, val] of Object.entries(quantities)) {
              if (key.endsWith("_tokens")) {
                totalTokens += Number(val);
              }
            }
            if (totalTokens > 0 && Number.isSafeInteger(totalTokens)) {
              await this.requestLimiter.recordTokens(apiKey.id, totalTokens);
            }
          }
        }
      } catch (e) {
        this.logger.error(`Error settling usage accounting:`, e);
      }
    } else if (prep?.reservationId) {
      await this.creditReservation.release(apiKey.id, prep.reservationId).catch(e => this.logger.error(`Failed to release reservation:`, e));
    }

    if (prep?.concurrencySlot) {
      await prep.concurrencySlot.release().catch(e => this.logger.error(`Failed to release concurrency slot:`, e));
    }

    const inputTokens = quantities.input_tokens ? String(quantities.input_tokens) : null;
    const outputTokens = quantities.output_tokens ? String(quantities.output_tokens) : null;
    const otherUsageDimensions = { ...quantities };
    delete otherUsageDimensions.input_tokens;
    delete otherUsageDimensions.output_tokens;
    const hasOther = Object.keys(otherUsageDimensions).length > 0;

    await this.requestLogs.record({
      requestId,
      apiKeyId: apiKey.id,
      model: prep?.resolved.model.publicName ?? "unknown",
      endpoint: action,
      status: finalStatus,
      latencyMs,
      inputTokens,
      outputTokens,
      otherUsageDimensions: hasOther ? otherUsageDimensions : null,
      calculatedCost: breakdown?.total ?? null,
      clientIp: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      upstream: logUpstream?.name ?? null,
      errorCode
    });
  }

  async process(
    apiKey: ApiKey,
    modelName: string,
    action: string,
    body: unknown,
    req: Request,
    abortSignal: AbortSignal,
    requestId: string
  ) {
    let finalStatus = "error";
    let errorCode: string | null = null;
    let latencyMs: number | null = null;
    let upstreamCallStartTime: number | null = null;
    let quantities: Record<string, string | number | bigint> = {};
    let usageComplete = false;
    let breakdown: CostBreakdown | null = null;
    let prep: Preparation | null = null;
    let stopHeartbeat: (() => void) | null = null;
    const trace: AttemptTrace = { upstream: null, servedBy: null, abortedInFlight: false };

    try {
      prep = await this.prepare(apiKey, modelName, action, body);
      stopHeartbeat = this.startLeaseHeartbeat(apiKey.id, prep);
      upstreamCallStartTime = Date.now();

      const timeoutMs = await this.numberSetting("timeouts.requestMs", 60_000);
      const upstreamOptions = { signal: abortSignal, timeoutMs };
      const providerModelName = prep.resolved.model.upstreamModelName;
      const jsonBody = prep.jsonBody;

      let responseBody: JsonObject;

      try {
        if (action === "generateContent") {
          responseBody = await this.callWithFallback(prep, abortSignal, trace, (provider) =>
            provider.generateContent(providerModelName, jsonBody, upstreamOptions)
          );
          const usage = usageQuantitiesFromMetadata(responseBody.usageMetadata);
          quantities = usage.quantities;
          usageComplete = usage.complete;
          try {
            breakdown = calculateCost(prep.rules, quantities, prep.requestStartedAt);
          } catch (e) {
            if (e instanceof PricingConfigurationError) {
              this.logger.error(`Pricing configuration error: ${e.message}`);
            } else {
              throw e;
            }
          }
        } else if (action === "countTokens") {
          responseBody = await this.callWithFallback(prep, abortSignal, trace, (provider) =>
            provider.countTokens(providerModelName, jsonBody, upstreamOptions)
          );
          breakdown = calculateCost([], {}, prep.requestStartedAt);
          quantities = {};
          usageComplete = true;
        } else if (action === "embedContent") {
          const res = await this.callWithFallback(prep, abortSignal, trace, (provider) =>
            provider.embedContent(providerModelName, jsonBody, upstreamOptions)
          );
          responseBody = res.response;
          if (res.inputTokens !== null) {
            quantities = { input_tokens: res.inputTokens };
            usageComplete = true;
          } else {
            usageComplete = false;
          }
          
          if (res.inputTokens !== null) {
            try {
              breakdown = calculateCost(prep.rules, quantities, prep.requestStartedAt);
            } catch(e) {
              if (e instanceof PricingConfigurationError) {
                this.logger.error(`Pricing configuration error: ${e.message}`);
              } else {
                throw e;
              }
            }
          }
        } else if (action === "batchEmbedContents") {
          const progress: BatchProgress = { items: 0, inputTokens: 0, tokensComplete: true, servedBy: null };
          try {
            responseBody = await this.embedBatch(prep, abortSignal, trace, providerModelName, upstreamOptions, progress);
          } catch (error) {
            // Items that already ran were billed by Vertex even though the batch failed, so the key
            // pays for them; otherwise a failing last item would make the rest free to repeat.
            if (progress.items > 0) {
              finalStatus = "partial";
              trace.servedBy = progress.servedBy;
            }
            throw error;
          } finally {
            ({ quantities, usageComplete, breakdown } = this.batchUsage(prep, progress));
          }
        } else {
          throw new Error(`Unexpected action ${action}`);
        }
        
        finalStatus = "success";
        return responseBody;
      } catch (error) {
        throw this.toGeminiError(error);
      }
    } catch (error) {
      errorCode = errorCodeOf(error);
      throw error;
    } finally {
      stopHeartbeat?.();
      if (upstreamCallStartTime) {
        latencyMs = Date.now() - upstreamCallStartTime;
      }
      
      await this.settle({
        apiKey,
        action,
        requestId,
        req,
        finalStatus,
        errorCode,
        latencyMs,
        quantities,
        usageComplete,
        breakdown,
        prep,
        usageUpstream: trace.servedBy ?? (trace.abortedInFlight ? trace.upstream : null),
        logUpstream: trace.upstream
      });
    }
  }


  async processStream(
    apiKey: ApiKey,
    modelName: string,
    body: unknown,
    req: Request,
    res: Response,
    clientSignal: AbortSignal,
    requestId: string
  ): Promise<void> {
    const action = "streamGenerateContent";
    let prep: Preparation | null = null;
    let upstreamStartedAt: number | null = null;
    const trace: AttemptTrace = { upstream: null, servedBy: null, abortedInFlight: false };
    // A separate controller so the idle timeout can abort the upstream without touching the client side.
    const upstreamAbort = new AbortController();
    const relayClientAbort = () => upstreamAbort.abort();
    clientSignal.addEventListener("abort", relayClientAbort, { once: true });

    let upstream: ReadableStream<Uint8Array>;
    let stopHeartbeat: (() => void) | null = null;
    try {
      prep = await this.prepare(apiKey, modelName, action, body);
      stopHeartbeat = this.startLeaseHeartbeat(apiKey.id, prep);
      upstreamStartedAt = Date.now();
      const timeoutMs = await this.numberSetting("timeouts.requestMs", 60_000);
      const providerModelName = prep.resolved.model.upstreamModelName;
      const jsonBody = prep.jsonBody;
      try {
        // Falling back is only possible here, before the SSE headers go out; once a byte has been
        // written the client has committed to this upstream's answer.
        upstream = await this.callWithFallback(prep, upstreamAbort.signal, trace, (provider) =>
          provider.streamGenerateContent(providerModelName, jsonBody, { signal: upstreamAbort.signal, timeoutMs })
        );
      } catch (error) {
        throw this.toGeminiError(error);
      }
    } catch (error) {
      // Nothing has been written yet, so the client still gets a normal JSON error with its status.
      stopHeartbeat?.();
      clientSignal.removeEventListener("abort", relayClientAbort);
      await this.settle({
        apiKey,
        action,
        requestId,
        req,
        finalStatus: "error",
        errorCode: errorCodeOf(error),
        latencyMs: upstreamStartedAt === null ? null : Date.now() - upstreamStartedAt,
        quantities: {},
        usageComplete: false,
        breakdown: null,
        prep,
        usageUpstream: trace.abortedInFlight ? trace.upstream : null,
        logUpstream: trace.upstream
      });
      throw error;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // The app has no compression middleware on purpose: compressing would hold chunks back until a
    // compression block fills, which defeats progressive delivery. Keep it that way.
    res.flushHeaders();
    this.metrics.incrementActiveStreams();

    const observed = new StreamObservation();
    let outcome: SseRelayOutcome = "upstream_failed";
    try {
      const idleTimeoutMs = await this.numberSetting("timeouts.streamIdleMs", 60_000);
      outcome = await relaySse(upstream, res, {
        idleTimeoutMs,
        clientSignal,
        upstreamAbort,
        onEvent: observed.onEvent
      });
    } catch (error) {
      upstreamAbort.abort();
      this.logger.error("Stream relay failed", error);
    } finally {
      stopHeartbeat?.();
      clientSignal.removeEventListener("abort", relayClientAbort);
      this.metrics.decrementActiveStreams();
    }

    if (outcome === "upstream_failed" || outcome === "idle_timeout") {
      this.metrics.incrementUpstreamFailure(outcome === "idle_timeout" ? "stream_idle_timeout" : "stream_interrupted");
    }
    const failureMessage = STREAM_FAILURE_MESSAGES[outcome];
    if (failureMessage !== null && !res.writableEnded && !res.destroyed) {
      res.write(sseErrorEvent(failureMessage));
    } else if (outcome === "client_closed" && clientSignal.reason instanceof GatewayShutdownError && !res.destroyed) {
      // The client is still there: tell it why the stream stopped so it can retry elsewhere.
      res.write(sseErrorEvent("The gateway is restarting. Please retry.", 503, "UNAVAILABLE"));
    }

    try {
      const cost =
        observed.usageMetadata === undefined
          ? await this.estimatedStreamCost(prep, observed.deliveredTextChars)
          : this.costFromUsage(observed.usageMetadata, prep);
      // Settled before the response ends, so the ledger and the concurrency slot are already up to
      // date when the client sees the end of the stream.
      await this.settle({
        apiKey,
        action,
        requestId,
        req,
        finalStatus: outcome === "completed" ? "success" : "partial",
        errorCode: STREAM_ERROR_CODES[outcome],
        latencyMs: Date.now() - upstreamStartedAt,
        quantities: cost.quantities,
        usageComplete: cost.usageComplete,
        breakdown: cost.breakdown,
        prep,
        usageUpstream: trace.servedBy,
        logUpstream: trace.servedBy
      });
    } catch (error) {
      // The status line is long gone, so the log is the only place this failure can go.
      this.logger.error("Failed to settle a streamed request", error);
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /**
   * Bills a stream that ended without token counts (the client left, or the upstream failed, before
   * the final event) from what the gateway saw: the request's estimated input and the answer text
   * already delivered. Otherwise reading everything but the last event would be free. The estimate
   * lands only in the pricing snapshot; the usage record's token columns stay empty and the cost is
   * marked undetermined.
   */
  private async estimatedStreamCost(
    prep: Preparation,
    deliveredTextChars: number
  ): Promise<{ quantities: Record<string, string | number | bigint>; usageComplete: boolean; breakdown: CostBreakdown | null }> {
    const policy = await this.reservationPolicy();
    const estimated = {
      input_tokens: estimateInputTokens(prep.jsonBody, policy),
      output_tokens: Math.ceil(deliveredTextChars / policy.charsPerToken)
    };
    if (estimated.input_tokens === 0 && estimated.output_tokens === 0) {
      return { quantities: {}, usageComplete: false, breakdown: null };
    }
    try {
      const breakdown = calculateCost(prep.rules, estimated, prep.requestStartedAt);
      return {
        quantities: {},
        usageComplete: false,
        breakdown: {
          ...breakdown,
          snapshot: {
            ...breakdown.snapshot,
            estimate: {
              basis: "stream ended without usage: request size and delivered text",
              quantities: { input_tokens: String(estimated.input_tokens), output_tokens: String(estimated.output_tokens) }
            }
          }
        }
      };
    } catch (error) {
      if (!(error instanceof PricingConfigurationError)) {
        throw error;
      }
      this.logger.error(`Pricing configuration error: ${error.message}`);
      return { quantities: {}, usageComplete: false, breakdown: null };
    }
  }

  private costFromUsage(
    usageMetadata: unknown,
    prep: Preparation
  ): { quantities: Record<string, string | number | bigint>; usageComplete: boolean; breakdown: CostBreakdown | null } {
    const usage = usageQuantitiesFromMetadata(usageMetadata);
    if (Object.keys(usage.quantities).length === 0) {
      return { quantities: {}, usageComplete: false, breakdown: null };
    }
    try {
      return { quantities: usage.quantities, usageComplete: usage.complete, breakdown: calculateCost(prep.rules, usage.quantities, prep.requestStartedAt) };
    } catch (error) {
      if (!(error instanceof PricingConfigurationError)) {
        throw error;
      }
      this.logger.error(`Pricing configuration error: ${error.message}`);
      return { quantities: usage.quantities, usageComplete: usage.complete, breakdown: null };
    }
  }

  private async planAttempts(resolved: ResolvedModel): Promise<Upstream[]> {
    const roundRobinCounter =
      resolved.strategy === "round_robin"
        ? await this.redis.client.incr(`routing:{${resolved.model.id}}:round-robin`)
        : 0;
    const plan = planRoute({
      strategy: resolved.strategy,
      candidates: resolved.candidates,
      defaultUpstreamId: resolved.model.upstreamId,
      roundRobinCounter
    });
    const attempts = plan.order
      .slice(0, maxAttempts(resolved.strategy, plan.order.length))
      .map((id) => resolved.upstreamsById.get(id))
      .filter((upstream): upstream is Upstream => upstream !== undefined);
    if (attempts.length === 0) {
      throw new GeminiApiException(404, "NOT_FOUND", `Model ${resolved.model.publicName} is not found.`);
    }
    return attempts;
  }

  private async embedBatch(
    prep: Preparation,
    abortSignal: AbortSignal,
    trace: AttemptTrace,
    providerModelName: string,
    upstreamOptions: { signal: AbortSignal; timeoutMs: number },
    progress: BatchProgress,
  ): Promise<JsonObject> {
    const items = prep.batchEmbedRequests;
    if (items === null) {
      throw new Error("batchEmbedContents was prepared without requests.");
    }

    const embeddings: unknown[] = [];
    for (const item of items) {
      // A later item's failure must not settle against an earlier item's upstream by accident; the
      // caller decides what a failed batch is charged to from `progress`.
      trace.servedBy = null;
      const res = await this.callWithFallback(prep, abortSignal, trace, (provider) =>
        provider.embedContent(providerModelName, item, upstreamOptions),
      );
      embeddings.push(res.response.embedding ?? null);
      progress.items += 1;
      progress.servedBy = trace.servedBy;
      if (res.inputTokens === null) {
        // One missing count leaves the batch's cost undetermined, same as a single embedContent.
        progress.tokensComplete = false;
      } else {
        progress.inputTokens += res.inputTokens;
      }
    }
    return { embeddings };
  }

  private batchUsage(
    prep: Preparation,
    progress: BatchProgress,
  ): { quantities: Record<string, string | number | bigint>; usageComplete: boolean; breakdown: CostBreakdown | null } {
    if (progress.items === 0) {
      return { quantities: {}, usageComplete: false, breakdown: null };
    }
    const quantities = { input_tokens: progress.inputTokens };
    try {
      return {
        quantities,
        usageComplete: progress.tokensComplete,
        breakdown: calculateCost(prep.rules, quantities, prep.requestStartedAt),
      };
    } catch (error) {
      if (!(error instanceof PricingConfigurationError)) {
        throw error;
      }
      this.logger.error(`Pricing configuration error: ${error.message}`);
      return { quantities, usageComplete: progress.tokensComplete, breakdown: null };
    }
  }

  /**
   * Runs the call against each planned upstream in turn, moving on only after a failure that
   * produced nothing billable and reached nobody (see isRetryableFailure). The reservation was made
   * once, before this, and only the attempt that answers is settled, so a fallback never bills twice.
   */
  private async callWithFallback<T>(
    prep: Preparation,
    signal: AbortSignal,
    trace: AttemptTrace,
    call: (provider: AIUpstreamProvider) => Promise<T>
  ): Promise<T> {
    for (const [index, upstream] of prep.attempts.entries()) {
      trace.upstream = upstream;
      try {
        // With another upstream still planned, moving on beats waiting out retries here.
        const isLastAttempt = index + 1 === prep.attempts.length;
        const result = isLastAttempt
          ? await this.callWithQuotaRetries(upstream, signal, trace, call)
          : await call(this.upstreams.forUpstream(upstream));
        trace.servedBy = upstream;
        return result;
      } catch (error) {
        trace.abortedInFlight = isAbortedInFlight(error);
        if (error instanceof UpstreamError) {
          this.metrics.incrementUpstreamFailure(error.kind);
        }
        const hasNext = index + 1 < prep.attempts.length;
        if (!hasNext || !isRetryableFailure(error, { responseStarted: false, clientAborted: signal.aborted })) {
          throw error;
        }
        this.logger.warn(
          `Upstream ${upstream.name} failed (${error instanceof UpstreamError ? error.kind : "error"}); trying ${prep.attempts[index + 1].name}`
        );
      }
    }
    throw new Error("No upstream to call.");
  }

  /**
   * Calls one upstream, retrying it with backoff while Vertex answers 429 for lack of shared capacity
   * (unbilled, and Google's documented remedy) or the connection could not be established (the
   * request never left). Nothing has reached the client at this point: a stream's headers go out
   * only after this returns.
   */
  private async callWithQuotaRetries<T>(
    upstream: Upstream,
    signal: AbortSignal,
    trace: AttemptTrace,
    call: (provider: AIUpstreamProvider) => Promise<T>
  ): Promise<T> {
    const delays = quotaRetryDelays();
    for (let retry = 0; ; retry += 1) {
      try {
        return await call(this.upstreams.forUpstream(upstream));
      } catch (error) {
        if (!isRetryableOnSameUpstream(error) || retry >= delays.length || signal.aborted) {
          throw error;
        }
        const kind = error instanceof UpstreamError ? error.kind : "error";
        const code = error instanceof UpstreamError && error.causeCode ? ` ${error.causeCode}` : "";
        this.metrics.incrementUpstreamFailure(kind);
        trace.abortedInFlight = false;
        const delay = jittered(delays[retry]);
        this.logger.warn(`Upstream ${upstream.name} failed (${kind}${code}); retry ${retry + 1} in ${delay} ms`);
        if (!(await sleepUnlessAborted(delay, signal))) {
          throw error;
        }
      }
    }
  }

  /**
   * One timer for the concurrency slot and the credit hold. Stop is idempotent
   * so a finally block can call it exactly once even if an earlier path already did.
   */
  private startLeaseHeartbeat(apiKeyId: string, prep: Preparation): () => void {
    const lease = currentLeaseMs();
    const reservationId = prep.reservationId;
    const timer = setInterval(() => {
      void prep.concurrencySlot.extend(lease).catch((error: unknown) => {
        this.logger.error("Failed to extend concurrency slot", error);
      });
      if (reservationId !== null) {
        void this.creditReservation.extend(apiKeyId, reservationId, lease).catch((error: unknown) => {
          this.logger.error("Failed to extend credit reservation", error);
        });
      }
    }, Math.floor(lease / 2));

    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    };
  }

  private async reservationPolicy(): Promise<ReservationPolicy> {
    const fileUriHoldTokens = await this.numberSetting("media.fileUriHoldTokens", 50_000);
    return {
      charsPerToken: 3,
      tokensPerMediaPart: 1000,
      defaultMaxOutputTokens: 8192,
      fileUriHoldTokens,
    };
  }

  private async numberSetting(
    key: "timeouts.requestMs" | "timeouts.streamIdleMs" | "media.maxInlineBytes" | "media.fileUriHoldTokens",
    fallback: number
  ): Promise<number> {
    const value = await this.settings.get(key);
    return typeof value === "number" ? value : fallback;
  }

  private toGeminiError(error: unknown): unknown {
    if (error instanceof UpstreamInputError) {
      return new GeminiApiException(400, "INVALID_ARGUMENT", error.message);
    }
    if (error instanceof UpstreamError) {
      this.logger.warn(
        `Upstream error: kind=${error.kind} status=${error.httpStatus}${error.causeCode ? ` code=${error.causeCode}` : ""}`
      );
      return mapUpstreamError(error);
    }
    return error;
  }
}

/** How far a batchEmbedContents request got, so a failure can still charge the items that ran. */
interface BatchProgress {
  items: number;
  inputTokens: number;
  tokensComplete: boolean;
  /** The upstream that served the last completed item. */
  servedBy: Upstream | null;
}

interface AttemptTrace {
  /** The upstream most recently called. */
  upstream: Upstream | null;
  /** The upstream that answered, once one has. */
  servedBy: Upstream | null;
  /** The last failure was a cancellation after the request was sent (possibly billed upstream). */
  abortedInFlight: boolean;
}

const STREAM_FAILURE_MESSAGES: Record<SseRelayOutcome, string | null> = {
  completed: null,
  client_closed: null,
  upstream_failed: "Upstream stream failed.",
  idle_timeout: "Upstream stream timed out."
};

const STREAM_ERROR_CODES: Record<SseRelayOutcome, string | null> = {
  completed: null,
  client_closed: "CANCELLED",
  upstream_failed: "INTERNAL",
  idle_timeout: "DEADLINE_EXCEEDED"
};

function errorCodeOf(error: unknown): string {
  if (error instanceof GeminiApiException) {
    const response = error.getResponse() as { error?: { status?: string } };
    return response.error?.status ?? "INTERNAL";
  }
  if (error instanceof HttpException) {
    return mapHttpStatusToGoogleStatus(error.getStatus());
  }
  return "INTERNAL";
}

export function mapUpstreamError(error: UpstreamError): GeminiApiException {
  if (error.kind === "authentication_failed" || error.kind === "permission_denied") {
    return new GeminiApiException(503, "UNAVAILABLE", "The model is temporarily unavailable.");
  } else if (error.kind === "model_unavailable") {
    return new GeminiApiException(404, "NOT_FOUND", "The model is not found.");
  } else if (error.kind === "quota_exhausted") {
    return new GeminiApiException(429, "RESOURCE_EXHAUSTED", "Upstream capacity exhausted. Please retry later.");
  } else if (error.kind === "network_error") {
    return new GeminiApiException(503, "UNAVAILABLE", "The model is temporarily unavailable.");
  } else if (error.kind === "upstream_error" && error.httpStatus === 400) {
    return new GeminiApiException(400, "INVALID_ARGUMENT", error.message);
  } else {
    // other upstream_error
    return new GeminiApiException(502, "UNAVAILABLE", "An error occurred with the upstream provider.");
  }
}

function mapHttpStatusToGoogleStatus(status: number): string {
  switch (status) {
    case 400: return "INVALID_ARGUMENT";
    case 401: return "UNAUTHENTICATED";
    case 403: return "PERMISSION_DENIED";
    case 404: return "NOT_FOUND";
    case 429: return "RESOURCE_EXHAUSTED";
    case 503: return "UNAVAILABLE";
    default: return "INTERNAL";
  }
}
