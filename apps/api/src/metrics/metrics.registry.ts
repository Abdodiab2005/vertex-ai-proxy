import { Injectable } from "@nestjs/common";

export const HTTP_REQUEST_DURATION_BUCKETS = [
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
] as const;

export const ROUTE_GROUPS = ["public", "admin", "health"] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

export const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export interface HttpMetricLabels {
  readonly routeGroup: RouteGroup;
  readonly statusClass: StatusClass;
}

interface HttpCounterSeries extends HttpMetricLabels {
  value: number;
}

interface HistogramSeries extends HttpMetricLabels {
  bucketCounts: number[];
  count: number;
  sum: number;
}

const HTTP_REQUESTS_HELP = "Total HTTP requests handled by the gateway.";
const HTTP_REQUEST_DURATION_HELP = "HTTP request duration in seconds.";
const ACTIVE_REQUESTS_HELP = "In-flight public API requests.";
const ACTIVE_STREAMS_HELP = "In-flight streaming responses.";
const UPSTREAM_FAILURES_HELP = "Upstream request failures.";
const CREDIT_REJECTIONS_HELP = "Credit reservation rejections.";
const RATE_LIMIT_REJECTIONS_HELP = "Rate limit rejections.";

/**
 * Holds process-local operational measurements. They intentionally reset on a
 * restart, while Prometheus preserves the historical series outside the process.
 */
@Injectable()
export class MetricsRegistry {
  private readonly httpRequestCounters = new Map<string, HttpCounterSeries>();
  private readonly httpRequestDurations = new Map<string, HistogramSeries>();
  private readonly upstreamFailures = new Map<string, number>();
  private readonly rateLimitRejections = new Map<string, number>();
  private activeRequests = 0;
  private activeStreams = 0;
  private creditRejections = 0;

  recordHttpRequest(labels: HttpMetricLabels, durationSeconds: number): void {
    this.incrementHttpRequests(labels);
    this.observeHttpRequestDuration(labels, durationSeconds);
  }

  incrementHttpRequests(labels: HttpMetricLabels): void {
    const key = httpLabelKey(labels);
    const series = this.httpRequestCounters.get(key);

    if (series !== undefined) {
      series.value += 1;
      return;
    }

    this.httpRequestCounters.set(key, {
      routeGroup: labels.routeGroup,
      statusClass: labels.statusClass,
      value: 1,
    });
  }

  observeHttpRequestDuration(labels: HttpMetricLabels, durationSeconds: number): void {
    const key = httpLabelKey(labels);
    const observation = normalizedDuration(durationSeconds);
    let series = this.httpRequestDurations.get(key);

    if (series === undefined) {
      series = {
        routeGroup: labels.routeGroup,
        statusClass: labels.statusClass,
        bucketCounts: Array.from({ length: HTTP_REQUEST_DURATION_BUCKETS.length }, () => 0),
        count: 0,
        sum: 0,
      };
      this.httpRequestDurations.set(key, series);
    }

    series.count += 1;
    series.sum += observation;

    for (const [index, bucket] of HTTP_REQUEST_DURATION_BUCKETS.entries()) {
      if (observation <= bucket) {
        series.bucketCounts[index] += 1;
      }
    }
  }

  incrementActiveRequests(): void {
    this.activeRequests += 1;
  }

  decrementActiveRequests(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  incrementActiveStreams(): void {
    this.activeStreams += 1;
  }

  decrementActiveStreams(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
  }

  incrementUpstreamFailure(kind: string): void {
    this.incrementLabeledCounter(this.upstreamFailures, kind);
  }

  incrementCreditRejection(): void {
    this.creditRejections += 1;
  }

  incrementRateLimitRejection(limit: string): void {
    this.incrementLabeledCounter(this.rateLimitRejections, limit);
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    appendMetadata(lines, "gateway_http_requests_total", HTTP_REQUESTS_HELP, "counter");
    for (const series of sortedHttpSeries(this.httpRequestCounters.values())) {
      lines.push(
        `gateway_http_requests_total${formatLabels([
          ["route_group", series.routeGroup],
          ["status_class", series.statusClass],
        ])} ${formatNumber(series.value)}`,
      );
    }

    appendMetadata(
      lines,
      "gateway_http_request_duration_seconds",
      HTTP_REQUEST_DURATION_HELP,
      "histogram",
    );
    for (const series of sortedHistogramSeries(this.httpRequestDurations.values())) {
      for (const [index, bucket] of HTTP_REQUEST_DURATION_BUCKETS.entries()) {
        lines.push(
          `gateway_http_request_duration_seconds_bucket${formatLabels([
            ["route_group", series.routeGroup],
            ["status_class", series.statusClass],
            ["le", formatNumber(bucket)],
          ])} ${formatNumber(series.bucketCounts[index])}`,
        );
      }
      lines.push(
        `gateway_http_request_duration_seconds_bucket${formatLabels([
          ["route_group", series.routeGroup],
          ["status_class", series.statusClass],
          ["le", "+Inf"],
        ])} ${formatNumber(series.count)}`,
      );
      lines.push(
        `gateway_http_request_duration_seconds_sum${formatLabels([
          ["route_group", series.routeGroup],
          ["status_class", series.statusClass],
        ])} ${formatNumber(series.sum)}`,
      );
      lines.push(
        `gateway_http_request_duration_seconds_count${formatLabels([
          ["route_group", series.routeGroup],
          ["status_class", series.statusClass],
        ])} ${formatNumber(series.count)}`,
      );
    }

    appendMetadata(lines, "gateway_active_requests", ACTIVE_REQUESTS_HELP, "gauge");
    lines.push(`gateway_active_requests ${formatNumber(this.activeRequests)}`);

    appendMetadata(lines, "gateway_active_streams", ACTIVE_STREAMS_HELP, "gauge");
    lines.push(`gateway_active_streams ${formatNumber(this.activeStreams)}`);

    appendMetadata(
      lines,
      "gateway_upstream_failures_total",
      UPSTREAM_FAILURES_HELP,
      "counter",
    );
    for (const [kind, value] of sortedLabeledCounter(this.upstreamFailures)) {
      lines.push(
        `gateway_upstream_failures_total${formatLabels([["kind", kind]])} ${formatNumber(value)}`,
      );
    }

    appendMetadata(
      lines,
      "gateway_credit_rejections_total",
      CREDIT_REJECTIONS_HELP,
      "counter",
    );
    lines.push(`gateway_credit_rejections_total ${formatNumber(this.creditRejections)}`);

    appendMetadata(
      lines,
      "gateway_rate_limit_rejections_total",
      RATE_LIMIT_REJECTIONS_HELP,
      "counter",
    );
    for (const [limit, value] of sortedLabeledCounter(this.rateLimitRejections)) {
      lines.push(
        `gateway_rate_limit_rejections_total${formatLabels([["limit", limit]])} ${formatNumber(value)}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  private incrementLabeledCounter(counter: Map<string, number>, label: string): void {
    counter.set(label, (counter.get(label) ?? 0) + 1);
  }
}

function appendMetadata(
  lines: string[],
  name: string,
  help: string,
  type: "counter" | "gauge" | "histogram",
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function httpLabelKey(labels: HttpMetricLabels): string {
  return `${labels.routeGroup}\u0000${labels.statusClass}`;
}

function normalizedDuration(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return 0;
  }

  return durationSeconds;
}

function sortedHttpSeries(
  series: Iterable<HttpCounterSeries>,
): HttpCounterSeries[] {
  return Array.from(series).sort(compareHttpLabels);
}

function sortedHistogramSeries(series: Iterable<HistogramSeries>): HistogramSeries[] {
  return Array.from(series).sort(compareHttpLabels);
}

function compareHttpLabels(
  left: HttpMetricLabels,
  right: HttpMetricLabels,
): number {
  const routeComparison = left.routeGroup.localeCompare(right.routeGroup);
  return routeComparison !== 0
    ? routeComparison
    : left.statusClass.localeCompare(right.statusClass);
}

function sortedLabeledCounter(counter: ReadonlyMap<string, number>): [string, number][] {
  return Array.from(counter.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function formatLabels(labels: ReadonlyArray<readonly [string, string]>): string {
  return `{${labels
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return String(value);
}
