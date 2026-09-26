import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import {
  API_KEY_STATUS_LABELS,
  UPSTREAM_STATUS_LABELS,
  isAnalyticsOverview,
  isAnalyticsTimeseries,
  type AnalyticsOverview,
  type AnalyticsRangeName,
  type AnalyticsTimeseries,
  type AnalyticsUpstream,
  type UpstreamStatus,
} from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { StatusBadge } from "../upstreams/status-badge";
import { RelativeTime } from "../upstreams/relative-time";
import { BarChart } from "./bar-chart";
import { formatCount, formatRate, formatUsd, formatUtcInstant, groupInteger } from "./format";
import { RangeSelector } from "./range-selector";

type DashboardSummaryResponse = {
  apiKeys: { total: number; active: number };
  upstreams: { total: number; enabled: number };
  models: { total: number; enabled: number };
  usageToday: { requests: number; costUsd: string };
};

const RANGES = ["24h", "7d", "30d"] as const;

const cardClass =
  "bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rawRange } = await searchParams;
  const range = selectedRange(rawRange);

  const summaryRes = await fetchGatewayAdmin<DashboardSummaryResponse>("/dashboard/summary");
  if (summaryRes.status === 401) {
    redirect("/login");
  }
  if (summaryRes.status !== 200 || !summaryRes.data) {
    return <ErrorPanel message={`Dashboard could not be loaded. (Status: ${summaryRes.status})`} />;
  }

  const { apiKeys, upstreams, models, usageToday } = summaryRes.data;

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className={cardClass}>
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">API Keys</h2>
          {apiKeys.total === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">No API keys yet</p>
          ) : (
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {apiKeys.active}{" "}
              <span className="text-sm font-normal text-zinc-500">active of {apiKeys.total}</span>
            </p>
          )}
        </div>

        <Link
          href="/upstreams"
          className={`${cardClass} hover:border-zinc-300 dark:hover:border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100`}
        >
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">Upstreams</h2>
          {upstreams.total === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">No upstreams configured</p>
          ) : (
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {upstreams.enabled}{" "}
              <span className="text-sm font-normal text-zinc-500">enabled of {upstreams.total}</span>
            </p>
          )}
        </Link>

        <div className={cardClass}>
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">Models</h2>
          {models.total === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">No models registered</p>
          ) : (
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {models.enabled}{" "}
              <span className="text-sm font-normal text-zinc-500">enabled of {models.total}</span>
            </p>
          )}
        </div>

        <div className={cardClass}>
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">Requests Today</h2>
          {usageToday.requests === 0 ? (
            <p className="text-zinc-600 dark:text-zinc-400">No traffic yet today</p>
          ) : (
            <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {usageToday.requests.toLocaleString()}
            </p>
          )}
        </div>

        <div className={cardClass}>
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">Cost Today</h2>
          <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">${usageToday.costUsd}</p>
        </div>
      </div>

      {range === null ? (
        <div className="space-y-4">
          <RangeSelector range={null} />
          <ErrorPanel message="Unknown time range. Choose 24 hours, 7 days, or 30 days." />
        </div>
      ) : (
        <AnalyticsSections range={range} />
      )}
    </div>
  );
}

function selectedRange(value: string | undefined): AnalyticsRangeName | null {
  if (value === undefined || value === "") {
    return "24h";
  }
  const match = RANGES.find((range) => range === value);
  return match ?? null;
}

async function AnalyticsSections({ range }: { range: AnalyticsRangeName }) {
  const [overviewRes, requestsRes, tokensRes, costRes, errorsRes] = await Promise.all([
    fetchGatewayAdmin<AnalyticsOverview>(`/analytics/overview?range=${range}`),
    fetchGatewayAdmin<AnalyticsTimeseries>(`/analytics/timeseries?metric=requests&range=${range}`),
    fetchGatewayAdmin<AnalyticsTimeseries>(`/analytics/timeseries?metric=tokens&range=${range}`),
    fetchGatewayAdmin<AnalyticsTimeseries>(`/analytics/timeseries?metric=cost&range=${range}`),
    fetchGatewayAdmin<AnalyticsTimeseries>(`/analytics/timeseries?metric=errors&range=${range}`),
  ]);

  if (
    overviewRes.status === 401 ||
    requestsRes.status === 401 ||
    tokensRes.status === 401 ||
    costRes.status === 401 ||
    errorsRes.status === 401
  ) {
    redirect("/login");
  }

  const overview = overviewRes.status === 200 && isAnalyticsOverview(overviewRes.data) ? overviewRes.data : null;
  const requests = seriesOrNull(requestsRes);
  const tokens = seriesOrNull(tokensRes);
  const cost = seriesOrNull(costRes);
  const errors = seriesOrNull(errorsRes);

  if (overview === null || requests === null || tokens === null || cost === null || errors === null) {
    const failed = [overviewRes, requestsRes, tokensRes, costRes, errorsRes].find(
      (result) => result.status !== 200 || result.data === null,
    );
    const detail = failed?.errorMessage ? ` ${failed.errorMessage}` : "";
    return (
      <div className="space-y-4">
        <RangeSelector range={range} />
        <ErrorPanel
          message={`Analytics could not be loaded. (Status: ${failed?.status ?? overviewRes.status}).${detail}`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Traffic</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {formatUtcInstant(overview.range.from)} to {formatUtcInstant(overview.range.to)}. The end
              instant is excluded. Times are UTC.
            </p>
          </div>
          <RangeSelector range={range} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Stat title="Requests today" value={formatCount(overview.requestsToday)} />
          <Stat title="Cost today" value={formatUsd(overview.costToday)} />
          <Stat title="Requests this month" value={formatCount(overview.requestsThisMonth)} />
          <Stat title="Cost this month" value={formatUsd(overview.costThisMonth)} />
          <Stat title="Requests in range" value={formatCount(overview.requestsInRange)} />
          <Stat title="Cost in range" value={formatUsd(overview.costInRange)} />
          <Stat title="Input tokens in range" value={groupInteger(overview.inputTokensInRange)} />
          <Stat title="Output tokens in range" value={groupInteger(overview.outputTokensInRange)} />
          <Stat title="Current RPM" value={formatCount(overview.currentRpm)} hint="Requests in the last 60 seconds." />
          <Stat title="Error rate" value={formatRate(overview.errorRate)} hint="Errors divided by requests in range." />
          <Stat
            title="Active streams"
            value={formatCount(overview.activeStreams)}
            hint="Live concurrency leases across API keys."
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Virtual credit (all keys)</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Gateway ledger across every API key. This balance is separate from Google Cloud billing.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Stat title="Allocated" value={formatUsd(overview.credit.totalAllocated)} hint="Added, removed, refunded, and adjusted." />
          <Stat title="Consumed" value={formatUsd(overview.credit.totalConsumed)} hint="Cost charged to keys." />
          <Stat title="Remaining" value={formatUsd(overview.credit.totalRemaining)} hint="Net of every ledger entry." />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Key status</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <Stat title={API_KEY_STATUS_LABELS.active} value={formatCount(overview.keys.active)} />
          <Stat title={API_KEY_STATUS_LABELS.suspended} value={formatCount(overview.keys.suspended)} />
          <Stat title={API_KEY_STATUS_LABELS.revoked} value={formatCount(overview.keys.revoked)} />
          <Stat title={API_KEY_STATUS_LABELS.expired} value={formatCount(overview.keys.expired)} />
          <Stat title={API_KEY_STATUS_LABELS.credit_exhausted} value={formatCount(overview.keys.creditExhausted)} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Upstream health</h2>
        {overview.upstreams.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No upstreams configured.</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {overview.upstreams.map((upstream) => (
              <UpstreamHealth key={upstream.id} upstream={upstream} />
            ))}
          </ul>
        )}
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <RankTable
          title="Top keys by cost"
          empty="No key usage in this range."
          columns={["Key", "Requests", "Cost"]}
          rows={overview.topKeys.map((key) => ({
            id: key.apiKeyId,
            cells: [
              <Link key="name" href={`/api-keys/${key.apiKeyId}`} className="font-medium hover:underline">
                {key.name}{" "}
                <span className="font-normal text-zinc-500 dark:text-zinc-400">{key.keyPrefix}</span>
              </Link>,
              formatCount(key.requests),
              formatUsd(key.cost),
            ],
          }))}
        />
        <RankTable
          title="Top models by cost"
          empty="No model usage in this range."
          columns={["Model", "Requests", "Cost"]}
          rows={overview.topModels.map((model) => ({
            id: model.modelId,
            cells: [
              <Link key="name" href={`/models/${model.modelId}`} className="font-medium hover:underline">
                {model.publicName}
              </Link>,
              formatCount(model.requests),
              formatUsd(model.cost),
            ],
          }))}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Over time</h2>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <BarChart label="Requests" bucket={requests.bucket} points={requests.points} />
          <BarChart label="Input + output tokens" bucket={tokens.bucket} points={tokens.points} />
          <BarChart label="Cost" bucket={cost.bucket} points={cost.points} />
          <BarChart label="Errors" bucket={errors.bucket} points={errors.points} />
        </div>
      </section>
    </div>
  );
}

function seriesOrNull(result: {
  status: number;
  data: AnalyticsTimeseries | null;
}): AnalyticsTimeseries | null {
  if (result.status !== 200 || !isAnalyticsTimeseries(result.data)) {
    return null;
  }
  return result.data;
}

function Stat({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className={cardClass}>
      <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">{title}</h3>
      <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{value}</p>
      {hint ? <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

function UpstreamHealth({ upstream }: { upstream: AnalyticsUpstream }) {
  return (
    <li className={`${cardClass} flex flex-wrap items-center gap-3`}>
      <Link href={`/upstreams/${upstream.id}`} className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline">
        {upstream.name}
      </Link>
      {isUpstreamStatus(upstream.status) ? (
        <StatusBadge status={upstream.status} />
      ) : (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {upstream.status}
        </span>
      )}
      <span className="text-sm text-zinc-500 dark:text-zinc-400">{upstream.enabled ? "Enabled" : "Disabled"}</span>
      <RelativeTime iso={upstream.lastCheckedAt} />
    </li>
  );
}

function isUpstreamStatus(status: string): status is UpstreamStatus {
  return Object.prototype.hasOwnProperty.call(UPSTREAM_STATUS_LABELS, status);
}

function RankTable({
  title,
  empty,
  columns,
  rows,
}: {
  title: string;
  empty: string;
  columns: string[];
  rows: { id: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="space-y-3 min-w-0">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                {columns.map((column) => (
                  <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                  {row.cells.map((cell, index) => (
                    <td key={`${row.id}-${index}`} className="px-4 py-3 text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
