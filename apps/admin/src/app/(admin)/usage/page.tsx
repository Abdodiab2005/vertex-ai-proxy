import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import {
  isUsageReport,
  type ApiKeysListResponse,
  type ModelsListResponse,
  type UpstreamsListResponse,
  type UsageReport,
} from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { formatCount, formatUsd, formatUtcInstant, groupInteger } from "../dashboard/format";
import { UsageFilters } from "./usage-filters";
import { firstQueryValue, parseUsageSearch } from "./window";

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseUsageSearch({
    apiKeyId: firstQueryValue(raw.apiKeyId),
    modelId: firstQueryValue(raw.modelId),
    upstreamId: firstQueryValue(raw.upstreamId),
    status: firstQueryValue(raw.status),
    endpoint: firstQueryValue(raw.endpoint),
    from: firstQueryValue(raw.from),
    to: firstQueryValue(raw.to),
  });

  const [keysRes, modelsRes, upstreamsRes] = await Promise.all([
    fetchGatewayAdmin<ApiKeysListResponse>("/api-keys?limit=200"),
    fetchGatewayAdmin<ModelsListResponse>("/models"),
    fetchGatewayAdmin<UpstreamsListResponse>("/upstreams"),
  ]);

  if (keysRes.status === 401 || modelsRes.status === 401 || upstreamsRes.status === 401) {
    redirect("/login");
  }

  if (
    keysRes.status !== 200 ||
    !keysRes.data ||
    !Array.isArray(keysRes.data.apiKeys) ||
    modelsRes.status !== 200 ||
    !modelsRes.data ||
    !Array.isArray(modelsRes.data.models) ||
    upstreamsRes.status !== 200 ||
    !upstreamsRes.data ||
    !Array.isArray(upstreamsRes.data.upstreams)
  ) {
    return <ErrorPanel message="Usage filters could not be loaded." />;
  }

  let report: UsageReport | null = null;
  let usageError: string | null = null;
  if (!parsed.ok) {
    usageError = parsed.message;
  } else {
    const usageRes = await fetchGatewayAdmin<UsageReport>(`/usage?${parsed.query.toString()}`);
    if (usageRes.status === 401) {
      redirect("/login");
    }
    if (usageRes.status === 200 && isUsageReport(usageRes.data)) {
      report = usageRes.data;
    } else {
      usageError =
        usageRes.errorMessage ?? `Usage could not be loaded. (Status: ${usageRes.status})`;
    }
  }

  const exportHref = parsed.ok ? `/admin-api/usage/export.csv?${parsed.query.toString()}` : null;
  const otherUsage = report === null ? [] : Object.entries(report.totals.otherUsage);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Usage</h1>
        {exportHref ? (
          <a
            href={exportHref}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          >
            Export CSV
          </a>
        ) : null}
      </div>

      <UsageFilters
        keys={keysRes.data.apiKeys}
        models={modelsRes.data.models}
        upstreams={upstreamsRes.data.upstreams}
        values={parsed.search}
      />
      {keysRes.data.total > keysRes.data.apiKeys.length ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The key list shows the first {keysRes.data.apiKeys.length} of {keysRes.data.total} keys.
        </p>
      ) : null}

      {usageError ? <ErrorPanel message={usageError} /> : null}

      {report ? (
        <div className="space-y-6">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Requests from {formatUtcInstant(report.range.from)} until {formatUtcInstant(report.range.to)}. The
            end instant is excluded. Dates in the filter are UTC calendar days, and the end date is included.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat title="Requests" value={formatCount(report.totals.requestCount)} />
            <Stat title="Success" value={formatCount(report.totals.successCount)} />
            <Stat title="Errors" value={formatCount(report.totals.errorCount)} />
            <Stat title="Partial" value={formatCount(report.totals.partialCount)} />
            <Stat title="Input tokens" value={groupInteger(report.totals.inputTokens)} />
            <Stat title="Output tokens" value={groupInteger(report.totals.outputTokens)} />
            <Stat title="Cost" value={formatUsd(report.totals.cost)} />
            <Stat title="Cost undetermined" value={formatCount(report.totals.costUndeterminedCount)} />
            <Stat
              title="Average latency"
              value={report.totals.avgLatencyMs === null ? "—" : `${formatCount(report.totals.avgLatencyMs)} ms`}
            />
          </div>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Other usage</h2>
            {otherUsage.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No extra billing dimensions in this window.</p>
            ) : (
              <ul className="flex flex-wrap gap-3">
                {otherUsage.map(([dimension, total]) => (
                  <li
                    key={dimension}
                    className="px-3 py-2 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-sm"
                  >
                    <span className="text-zinc-500 dark:text-zinc-400">{dimension}</span>{" "}
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{groupInteger(total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <UsageTable
            title="By day"
            empty="No requests in this window."
            columns={["Day", "Requests", "Cost"]}
            rows={report.byDay.map((row) => ({
              id: row.day,
              cells: [row.day, formatCount(row.requests), formatUsd(row.cost)],
            }))}
          />
          <UsageTable
            title="By model"
            empty="No model usage in this window."
            columns={["Model", "Requests", "Cost"]}
            rows={report.byModel.map((row) => ({
              id: row.modelId,
              cells: [
                <Link key={row.modelId} href={`/models/${row.modelId}`} className="font-medium hover:underline">
                  {row.publicName}
                </Link>,
                formatCount(row.requests),
                formatUsd(row.cost),
              ],
            }))}
          />
          <UsageTable
            title="By key"
            empty="No key usage in this window."
            columns={["Key", "Requests", "Cost"]}
            rows={report.byKey.map((row) => ({
              id: row.apiKeyId,
              cells: [
                <Link key={row.apiKeyId} href={`/api-keys/${row.apiKeyId}`} className="font-medium hover:underline">
                  {row.name}{" "}
                  <span className="font-normal text-zinc-500 dark:text-zinc-400">{row.keyPrefix}</span>
                </Link>,
                formatCount(row.requests),
                formatUsd(row.cost),
              ],
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">{title}</h2>
      <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-all">{value}</p>
    </div>
  );
}

function UsageTable({
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
    <section className="space-y-3">
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
                    <td
                      key={`${row.id}-${index}`}
                      className="px-4 py-3 text-zinc-900 dark:text-zinc-100 whitespace-nowrap"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
