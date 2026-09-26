import { AlertRule, RuleContext } from "./types.js";
import { toMicros } from "../../credits/money.js";

/**
 * credit_80 rule (warning):
 * A key whose consumed >= 80% of (consumed + remaining) and remaining > 0.
 * Only keys whose status is active or credit_exhausted.
 * BigInt micro-unit math.
 */
export class Credit80Rule implements AlertRule {
  readonly type = "credit_80";
  readonly name = "Credit usage at 80%";

  evaluate(context: RuleContext & { apiKeyId: string }): ReturnType<AlertRule["evaluate"]> {
    const { creditSummary, apiKeyId } = context;
    if (!creditSummary) {
      return null;
    }

    // totalConsumed is negative (cost_consumed amounts are negative debits)
    // "consumed" in the business sense is the positive magnitude
    const consumedMicros = -toMicros(creditSummary.totalConsumed);
    const remainingMicros = toMicros(creditSummary.remaining);

    // Only alert if remaining > 0 (has credit) and consumed >= 80% of (consumed + remaining)
    if (remainingMicros <= 0n) {
      return null;
    }

    const totalMicros = consumedMicros + remainingMicros;
    if (totalMicros === 0n) {
      return null; // No credit at all, can't calculate percentage
    }

    // Check if consumed >= 80% of total
    // Using integer math: consumed * 100 >= total * 80
    const percentage = (consumedMicros * 100n) / totalMicros;
    const shouldAlert = percentage >= 80n;

    if (!shouldAlert) {
      return null;
    }

    return {
      shouldAlert: true,
      dedupeKey: `credit_80:${apiKeyId}`,
      title: "Credit usage at 80%",
      message: `API key has consumed ${percentage}% of its available credit (${formatMicrosForDisplay(consumedMicros)} of ${formatMicrosForDisplay(totalMicros)})`,
      data: {
        apiKeyId,
        consumed: creditSummary.totalConsumed,
        remaining: creditSummary.remaining,
        percentage: percentage.toString(),
      },
      severity: "warning",
    };
  }
}

/**
 * credit_100 rule (critical):
 * A key whose remaining <= 0 and that has had any credit added.
 */
export class Credit100Rule implements AlertRule {
  readonly type = "credit_100";
  readonly name = "Credit exhausted";

  evaluate(context: RuleContext & { apiKeyId: string }): ReturnType<AlertRule["evaluate"]> {
    const { creditSummary, apiKeyId } = context;
    if (!creditSummary) {
      return null;
    }

    const remainingMicros = toMicros(creditSummary.remaining);
    const totalAddedMicros = toMicros(creditSummary.totalAdded);

    // Alert if remaining <= 0 AND there has been credit added at some point
    if (remainingMicros > 0n) {
      return null;
    }

    if (totalAddedMicros === 0n) {
      return null; // Never had credit, don't alert
    }

    return {
      shouldAlert: true,
      dedupeKey: `credit_100:${apiKeyId}`,
      title: "Credit exhausted",
      message: `API key has exhausted all credit (remaining: ${creditSummary.remaining})`,
      data: {
        apiKeyId,
        consumed: creditSummary.totalConsumed,
        remaining: creditSummary.remaining,
        totalAdded: creditSummary.totalAdded,
      },
      severity: "critical",
    };
  }
}

/**
 * high_error_rate rule (warning): at least 20 public requests in the window, of which at least 20%
 * failed. Counted from request_logs, because a failed upstream call leaves no usage record.
 */
export const HIGH_ERROR_RATE_WINDOW_MINUTES = 15;

export class HighErrorRateRule implements AlertRule {
  readonly type = "high_error_rate";
  readonly name = "High error rate";

  evaluate(context: RuleContext): ReturnType<AlertRule["evaluate"]> {
    const counts = context.requestCounts;
    // errors / total >= 20%, in integers.
    if (!counts || counts.total < 20 || counts.errors * 5 < counts.total) {
      return null;
    }

    const percent = Math.round((counts.errors * 1000) / counts.total) / 10;
    return {
      shouldAlert: true,
      dedupeKey: "high_error_rate:global",
      title: "High error rate detected",
      message: `${percent}% of public requests failed over the last ${HIGH_ERROR_RATE_WINDOW_MINUTES} minutes (${counts.errors} of ${counts.total}).`,
      data: {
        errorCount: counts.errors,
        totalCount: counts.total,
        errorRatePercent: percent,
        windowMinutes: HIGH_ERROR_RATE_WINDOW_MINUTES,
      },
      severity: "warning",
    };
  }
}

/**
 * upstream_unavailable rule (critical):
 * An enabled upstream whose status is one of
 * authentication_failed, permission_denied, network_error, quota_exhausted, upstream_error.
 */
export class UpstreamUnavailableRule implements AlertRule {
  readonly type = "upstream_unavailable";
  readonly name = "Upstream unavailable";

  private static readonly UNHEALTHY_STATUSES = new Set([
    "authentication_failed",
    "permission_denied",
    "network_error",
    "quota_exhausted",
    "upstream_error",
  ]);

  evaluate(context: RuleContext): ReturnType<AlertRule["evaluate"]> {
    const { upstream } = context;
    if (!upstream) {
      return null;
    }

    if (!upstream.enabled) {
      return null; // Disabled upstreams don't generate alerts
    }

    const isUnhealthy = UpstreamUnavailableRule.UNHEALTHY_STATUSES.has(
      upstream.status,
    );

    if (!isUnhealthy) {
      return null;
    }

    return {
      shouldAlert: true,
      dedupeKey: `upstream_unavailable:${upstream.id}`,
      title: "Upstream unavailable",
      message: `Upstream "${upstream.name}" is in ${upstream.status} state`,
      data: {
        upstreamId: upstream.id,
        upstreamName: upstream.name,
        status: upstream.status,
        lastCheckedAt: upstream.lastCheckedAt?.toISOString() ?? null,
      },
      severity: "critical",
    };
  }
}

/**
 * spend_threshold rule (critical):
 * The gateway's tracked spend reached the configured usable target
 * (reuse the settings spend math; only when a budget is configured).
 */
export class SpendThresholdRule implements AlertRule {
  readonly type = "spend_threshold";
  readonly name = "Spend threshold reached";

  evaluate(context: RuleContext): ReturnType<AlertRule["evaluate"]> {
    const { spendStatus } = context;
    if (!spendStatus) {
      return null;
    }

    if (!spendStatus.thresholdReached) {
      return null;
    }

    return {
      shouldAlert: true,
      dedupeKey: "spend_threshold:global",
      title: "Spend threshold reached",
      message: `Gateway tracked spend (${spendStatus.trackedSpendUsd}) has reached the usable target (${spendStatus.usableTarget})`,
      data: {
        trackedSpendUsd: spendStatus.trackedSpendUsd,
        upstreamBudget: spendStatus.upstreamBudget,
        safetyReserve: spendStatus.safetyReserve,
        usableTarget: spendStatus.usableTarget,
      },
      severity: "critical",
    };
  }
}

function formatMicrosForDisplay(micros: bigint): string {
  const negative = micros < 0n;
  const absoluteMicros = negative ? -micros : micros;
  const integerPart = absoluteMicros / 1_000_000n;
  const fractionalPart = absoluteMicros % 1_000_000n;
  const sign = negative ? "-" : "";
  return `${sign}${integerPart}.${fractionalPart.toString().padStart(6, "0")}`;
}