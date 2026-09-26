import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import {
  type ApiKeysListResponse,
  type ApiKeyView,
} from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { RelativeTime } from "../upstreams/relative-time";
import { formatCount, formatUsd, groupInteger } from "../dashboard/format";
import { ApiKeyStatusBadge } from "./status-badge";
import { ApiKeyFilters } from "./filters";

const addButtonClassName =
  "inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-colors";

const secondaryLinkClassName =
  "inline-flex items-center px-3 py-1.5 text-sm font-medium text-zinc-700 bg-white border border-zinc-300 rounded-md hover:bg-zinc-50 dark:text-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 dark:hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100";

interface PageProps {
  searchParams: Promise<{
    search?: string;
    status?: string;
    page?: string;
  }>;
}

export default async function ApiKeysPage({ searchParams }: PageProps) {
  const { search, status, page } = await searchParams;

  const limit = 50;
  const offset = (Number(page) - 1) * limit || 0;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const res = await fetchGatewayAdmin<ApiKeysListResponse>(`/api-keys?${params.toString()}`);

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.apiKeys)) {
    return <ErrorPanel message={`API keys could not be loaded. (Status: ${res.status})`} />;
  }

  const { apiKeys, total } = res.data;
  const currentPage = Number(page) || 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">API Keys</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/api-keys/presets" className={secondaryLinkClassName}>
            Presets
          </Link>
          <Link href="/api-keys/bulk" className={secondaryLinkClassName}>
            Bulk generate
          </Link>
          <Link href="/api-keys/new" className={addButtonClassName}>
            Create API key
          </Link>
        </div>
      </div>

      <ApiKeyFilters search={search} status={status} />

      {apiKeys.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center space-y-4">
          <p className="text-zinc-600 dark:text-zinc-400">No API keys yet</p>
          <Link href="/api-keys/new" className={addButtonClassName}>
            Create API key
          </Link>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
            <table className="min-w-full text-sm text-start">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Name</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Key Prefix</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Remaining Credit</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Consumed Credit</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Requests Today</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Usage This Month (tokens)</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">RPM</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Expires</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Last Used</th>
                  <th scope="col" className="px-4 py-3 font-medium whitespace-nowrap">Created</th>
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((apiKey: ApiKeyView) => (
                  <tr
                    key={apiKey.id}
                    className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/api-keys/${encodeURIComponent(apiKey.id)}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
                      >
                        {apiKey.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono" dir="ltr">
                      {apiKey.keyPrefix}...
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <ApiKeyStatusBadge status={apiKey.status} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
                      {formatUsd(apiKey.credit?.remaining ?? "0")}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
                      {formatUsd(apiKey.credit?.consumed ?? "0")}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
                      {formatCount(apiKey.requestsToday ?? 0)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
                      {groupInteger(apiKey.tokensThisMonth ?? "0")}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono tabular-nums" dir="ltr">
                      <RpmLimit value={apiKey.requestsPerMinute} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                      <RelativeTime iso={apiKey.expiresAt} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                      <RelativeTime iso={apiKey.lastUsedAt} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                      <RelativeTime iso={apiKey.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Page {currentPage} of {totalPages} — {total} total
              </p>
              <div className="flex items-center gap-2">
                {currentPage > 1 && (
                  <Link
                    href={`/api-keys?${new URLSearchParams({ search: search ?? "", status: status ?? "", page: String(currentPage - 1) }).toString()}`}
                    className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                  >
                    Previous
                  </Link>
                )}
                {currentPage < totalPages && (
                  <Link
                    href={`/api-keys?${new URLSearchParams({ search: search ?? "", status: status ?? "", page: String(currentPage + 1) }).toString()}`}
                    className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RpmLimit({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span title="No limit" aria-label="unlimited">
        ∞
      </span>
    );
  }
  return <>{formatCount(value)}</>;
}