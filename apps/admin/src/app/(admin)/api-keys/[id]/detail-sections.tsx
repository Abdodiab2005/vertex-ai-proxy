import Link from "next/link";
import { formatCount, formatUsd } from "../../dashboard/format";
import { RelativeTime } from "../../upstreams/relative-time";
import type {
  ApiKeyView,
  AuditLogEntry,
  CreditTransactionView,
  CreditsListResponse,
  LimitsUsageResponse,
  LimitValue,
  RequestLogEntry,
  UsageSummaryResponse,
} from "../../../../lib/types";
import { REQUEST_LOG_STATUS_LABELS } from "../../../../lib/types";
import { ApiKeyForm } from "../api-key-form";
import { CreditForms } from "./credit-forms";
import { ResetCountersButton } from "./reset-counters";

const cardClassName =
  "bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm";

const tableWrapClassName =
  "overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm";

const linkClassName =
  "text-sm font-medium text-zinc-700 underline hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm";

const SECTIONS = [
  ["overview", "Overview"],
  ["credit", "Credit"],
  ["usage", "Usage"],
  ["limits", "Limits"],
  ["models", "Allowed models"],
  ["requests", "Request history"],
  ["errors", "Errors"],
  ["ip", "IP information"],
  ["audit", "Audit history"],
] as const;

const CREDIT_TYPE_LABELS: Record<string, string> = {
  credit_added: "Added",
  credit_removed: "Removed",
  cost_consumed: "Consumed",
  manual_adjustment: "Adjustment",
  refund: "Refund",
};

export function ApiKeySectionNav() {
  return (
    <nav aria-label="API key sections" className="flex flex-wrap gap-2">
      {SECTIONS.map(([id, label]) => (
        <a
          key={id}
          href={`#${id}`}
          className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-700 bg-white border border-zinc-300 hover:bg-zinc-50 dark:text-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function sectionClassName() {
  return "scroll-mt-6 space-y-3";
}

export function CreditSection({
  apiKeyId,
  credits,
  page,
  pageSize,
}: {
  apiKeyId: string;
  credits: CreditsListResponse;
  page: number;
  pageSize: number;
}) {
  const totalPages = Math.max(1, Math.ceil(credits.total / pageSize));
  const summaryRows: Array<[string, string]> = [
    ["Remaining", credits.summary.remaining],
    ["Added", credits.summary.totalAdded],
    ["Removed", credits.summary.totalRemoved],
    ["Consumed", credits.summary.totalConsumed],
    ["Refunded", credits.summary.totalRefunded],
    ["Adjustments", credits.summary.adjustmentsNet],
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {summaryRows.map(([label, value]) => (
          <div key={label} className={cardClassName}>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 font-mono tabular-nums" dir="ltr">
              {formatUsd(value)}
              {credits.summary.currency ? ` ${credits.summary.currency}` : ""}
            </p>
          </div>
        ))}
      </div>

      <CreditForms apiKeyId={apiKeyId} />

      {credits.transactions.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No credit transactions.</p>
      ) : (
        <div className={tableWrapClassName}>
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Time</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Type</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Amount</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Description</th>
              </tr>
            </thead>
            <tbody>
              {credits.transactions.map((transaction) => (
                <CreditRow key={transaction.id} transaction={transaction} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Page {page} of {totalPages} — {credits.total} total
          </p>
          <div className="flex items-center gap-3">
            {page > 1 && (
              <Link href={creditsHref(apiKeyId, page - 1)} className={linkClassName}>
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link href={creditsHref(apiKeyId, page + 1)} className={linkClassName}>
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CreditRow({ transaction }: { transaction: CreditTransactionView }) {
  return (
    <tr className="border-b border-zinc-200 dark:border-zinc-800 last:border-0">
      <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
        <RelativeTime iso={transaction.createdAt} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
        {CREDIT_TYPE_LABELS[transaction.type] ?? transaction.type}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
        {formatUsd(transaction.amount)}
      </td>
      <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{transaction.description ?? "—"}</td>
    </tr>
  );
}

function creditsHref(id: string, page: number): string {
  const params = new URLSearchParams();
  if (page > 1) {
    params.set("creditsPage", String(page));
  }
  const query = params.toString();
  return `/api-keys/${encodeURIComponent(id)}${query.length > 0 ? `?${query}` : ""}#credit`;
}

export function UsageSection({ summary }: { summary: UsageSummaryResponse }) {
  const empty = summary.byModel.length === 0 && summary.byDimension.length === 0;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Last 30 days.</p>
      {empty ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No usage in the last 30 days.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">By model</h3>
            <UsageModelTable summary={summary} />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">By dimension</h3>
            <UsageDimensionTable summary={summary} />
          </div>
        </div>
      )}
    </div>
  );
}

function UsageModelTable({ summary }: { summary: UsageSummaryResponse }) {
  if (summary.byModel.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No model usage.</p>;
  }
  return (
    <div className={tableWrapClassName}>
      <table className="min-w-full text-sm text-start">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
            <th scope="col" className="px-4 py-3 font-medium">Model</th>
            <th scope="col" className="px-4 py-3 font-medium">Requests</th>
            <th scope="col" className="px-4 py-3 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {summary.byModel.map((row) => (
            <tr key={row.modelId} className="border-b border-zinc-200 dark:border-zinc-800 last:border-0">
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{row.publicName ?? row.modelId}</td>
              <td className="px-4 py-3 font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                {formatCount(row.requests)}
              </td>
              <td className="px-4 py-3 font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageDimensionTable({ summary }: { summary: UsageSummaryResponse }) {
  if (summary.byDimension.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No dimension costs.</p>;
  }
  return (
    <div className={tableWrapClassName}>
      <table className="min-w-full text-sm text-start">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
            <th scope="col" className="px-4 py-3 font-medium">Dimension</th>
            <th scope="col" className="px-4 py-3 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {summary.byDimension.map((row) => (
            <tr key={row.dimension} className="border-b border-zinc-200 dark:border-zinc-800 last:border-0">
              <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">{row.dimension}</td>
              <td className="px-4 py-3 font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LimitsSection({ apiKeyId, limitsUsage }: { apiKeyId: string; limitsUsage: LimitsUsageResponse }) {
  const rows: Array<{ label: string; limit: LimitValue; counter: number | null }> = [
    {
      label: "Requests this minute",
      limit: limitsUsage.limits.requestsPerMinute,
      counter: limitsUsage.usage.requestsThisMinute,
    },
    {
      label: "Requests today",
      limit: limitsUsage.limits.requestsPerDay,
      counter: limitsUsage.usage.requestsToday,
    },
    {
      label: "Tokens this minute",
      limit: limitsUsage.limits.tokensPerMinute,
      counter: limitsUsage.usage.tokensThisMinute,
    },
    {
      label: "Tokens today",
      limit: limitsUsage.limits.tokensPerDay,
      counter: limitsUsage.usage.tokensToday,
    },
    {
      label: "Tokens this month",
      limit: limitsUsage.limits.tokensPerMonth,
      counter: limitsUsage.usage.tokensThisMonth,
    },
    {
      label: "Max concurrent requests",
      limit: limitsUsage.limits.maxConcurrentRequests,
      counter: null,
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Live rate-limit windows. Resetting them does not change usage history or credit.{" "}
        <a href="#edit-key" className={linkClassName}>
          Edit the limits
        </a>
        .
      </p>
      <div className={tableWrapClassName}>
        <table className="min-w-full text-sm text-start">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
              <th scope="col" className="px-4 py-3 font-medium">Window</th>
              <th scope="col" className="px-4 py-3 font-medium">Limit</th>
              <th scope="col" className="px-4 py-3 font-medium">Counter</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-zinc-200 dark:border-zinc-800 last:border-0">
                <th scope="row" className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100 text-start">
                  {row.label}
                </th>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  <LimitFigure value={row.limit} />
                </td>
                <td className="px-4 py-3 font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                  {row.counter === null ? "—" : formatCount(row.counter)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ResetCountersButton apiKeyId={apiKeyId} />
    </div>
  );
}

function LimitFigure({ value }: { value: LimitValue }) {
  if (value === null) {
    return (
      <span title="No limit" aria-label="unlimited">
        ∞
      </span>
    );
  }
  return (
    <span className="font-mono tabular-nums" dir="ltr">
      {formatCount(value)}
    </span>
  );
}

export function ModelsSection({ apiKey }: { apiKey: ApiKeyView }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StringList title="Allowed models" values={apiKey.allowedModels} emptyLabel="All models allowed." />
        <StringList title="Blocked models" values={apiKey.blockedModels} emptyLabel="No models blocked." />
      </div>
      <div id="edit-key" className="scroll-mt-6 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Edit key</h3>
        <ApiKeyForm mode="edit" apiKey={apiKey} />
      </div>
    </div>
  );
}

export function IpSection({ apiKey, lastClientIp }: { apiKey: ApiKeyView; lastClientIp: string | null }) {
  return (
    <div className="space-y-4">
      <div className={cardClassName}>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Last seen client IP</p>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 font-mono" dir="ltr">
          {lastClientIp ?? "No client IP in the latest request logs."}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StringList title="Allowed IPs" values={apiKey.allowedIPs} emptyLabel="Any IP allowed." />
        <StringList title="Blocked IPs" values={apiKey.blockedIPs} emptyLabel="No IPs blocked." />
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Change these lists in{" "}
        <a href="#edit-key" className={linkClassName}>
          Edit key
        </a>
        .
      </p>
    </div>
  );
}

function StringList({ title, values, emptyLabel }: { title: string; values: string[]; emptyLabel: string }) {
  return (
    <div className={cardClassName}>
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {values.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm font-mono text-zinc-700 dark:text-zinc-300" dir="ltr">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RequestHistorySection({ apiKeyId, entries }: { apiKeyId: string; entries: RequestLogEntry[] }) {
  const href = `/request-logs?apiKeyId=${encodeURIComponent(apiKeyId)}`;
  return (
    <div className="space-y-3">
      <LogTable entries={entries} emptyLabel="No request logs for this key." />
      <Link href={href} className={linkClassName}>
        View all request logs for this key
      </Link>
    </div>
  );
}

export function ErrorsSection({ apiKeyId, entries }: { apiKeyId: string; entries: RequestLogEntry[] }) {
  const href = `/request-logs?apiKeyId=${encodeURIComponent(apiKeyId)}&status=error`;
  return (
    <div className="space-y-3">
      <LogTable entries={entries} emptyLabel="No error logs for this key." />
      <Link href={href} className={linkClassName}>
        View error logs for this key
      </Link>
    </div>
  );
}

function LogTable({ entries, emptyLabel }: { entries: RequestLogEntry[]; emptyLabel: string }) {
  if (entries.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">{emptyLabel}</p>;
  }
  return (
    <div className={tableWrapClassName}>
      <table className="min-w-full text-sm text-start">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Time</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Model</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Endpoint</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Latency</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Tokens</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Cost</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Client IP</th>
            <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Error</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-zinc-200 dark:border-zinc-800 last:border-0">
              <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                <RelativeTime iso={entry.createdAt} />
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {entry.model ?? "—"}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {entry.endpoint}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                {REQUEST_LOG_STATUS_LABELS[entry.status as keyof typeof REQUEST_LOG_STATUS_LABELS] ?? entry.status}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                {entry.latencyMs === null ? "—" : formatCount(entry.latencyMs)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300" dir="ltr">
                {entry.inputTokens ?? "—"} / {entry.outputTokens ?? "—"}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono tabular-nums text-zinc-700 dark:text-zinc-300" dir="ltr">
                {entry.calculatedCost === null ? "—" : formatUsd(entry.calculatedCost)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300" dir="ltr">
                {entry.clientIp ?? "—"}
              </td>
              <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {entry.errorCode ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditSection({ apiKeyId, entries }: { apiKeyId: string; entries: AuditLogEntry[] }) {
  const href = `/audit-log?entityType=api_key&entityId=${encodeURIComponent(apiKeyId)}`;
  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No audit entries for this key.</p>
      ) : (
        <div className={tableWrapClassName}>
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Time</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Action</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Admin</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">IP</th>
                <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Changes</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 align-top">
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    <RelativeTime iso={entry.createdAt} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    {entry.action}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {entry.adminEmail ?? "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-zinc-700 dark:text-zinc-300" dir="ltr">
                    {entry.ipAddress ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                    <details>
                      <summary className="cursor-pointer text-sm">View</summary>
                      <pre className="mt-2 max-w-xl overflow-x-auto whitespace-pre-wrap break-all text-xs" dir="ltr">
                        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link href={href} className={linkClassName}>
        View the full audit log for this key
      </Link>
    </div>
  );
}

export function lastSeenClientIp(entries: readonly RequestLogEntry[]): string | null {
  for (const entry of entries) {
    if (typeof entry.clientIp === "string" && entry.clientIp.length > 0) {
      return entry.clientIp;
    }
  }
  return null;
}
