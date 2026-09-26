import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.registry.js";

describe("MetricsRegistry", () => {
  it("renders Prometheus text with escaped labels and cumulative histogram buckets", () => {
    const metrics = new MetricsRegistry();
    metrics.recordHttpRequest(
      { routeGroup: "public", statusClass: "2xx" },
      0.12,
    );
    metrics.incrementActiveRequests();
    metrics.incrementActiveStreams();
    metrics.incrementUpstreamFailure('vertex\\primary"\nretry');
    metrics.incrementCreditRejection();
    metrics.incrementRateLimitRejection('requests\\minute"\nlimit');

    expect(metrics.renderPrometheus()).toBe(`\
# HELP gateway_http_requests_total Total HTTP requests handled by the gateway.
# TYPE gateway_http_requests_total counter
gateway_http_requests_total{route_group="public",status_class="2xx"} 1
# HELP gateway_http_request_duration_seconds HTTP request duration in seconds.
# TYPE gateway_http_request_duration_seconds histogram
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="0.05"} 0
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="0.1"} 0
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="0.25"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="0.5"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="1"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="2.5"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="5"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="10"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="30"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="60"} 1
gateway_http_request_duration_seconds_bucket{route_group="public",status_class="2xx",le="+Inf"} 1
gateway_http_request_duration_seconds_sum{route_group="public",status_class="2xx"} 0.12
gateway_http_request_duration_seconds_count{route_group="public",status_class="2xx"} 1
# HELP gateway_active_requests In-flight public API requests.
# TYPE gateway_active_requests gauge
gateway_active_requests 1
# HELP gateway_active_streams In-flight streaming responses.
# TYPE gateway_active_streams gauge
gateway_active_streams 1
# HELP gateway_upstream_failures_total Upstream request failures.
# TYPE gateway_upstream_failures_total counter
gateway_upstream_failures_total{kind="vertex\\\\primary\\"\\nretry"} 1
# HELP gateway_credit_rejections_total Credit reservation rejections.
# TYPE gateway_credit_rejections_total counter
gateway_credit_rejections_total 1
# HELP gateway_rate_limit_rejections_total Rate limit rejections.
# TYPE gateway_rate_limit_rejections_total counter
gateway_rate_limit_rejections_total{limit="requests\\\\minute\\"\\nlimit"} 1
`);
  });

  it("does not allow in-flight gauges to become negative", () => {
    const metrics = new MetricsRegistry();

    metrics.decrementActiveRequests();
    metrics.decrementActiveStreams();

    expect(metrics.renderPrometheus()).toContain("gateway_active_requests 0");
    expect(metrics.renderPrometheus()).toContain("gateway_active_streams 0");
  });
});
