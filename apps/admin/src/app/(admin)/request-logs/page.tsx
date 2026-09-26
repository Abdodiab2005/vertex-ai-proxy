import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import type { RequestLogsListResponse } from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { RequestLogTable } from "./request-log-table";
import { RequestLogFilters } from "./request-log-filters";

interface PageProps {
  searchParams: Promise<{
    apiKeyId?: string;
    model?: string;
    endpoint?: string;
    status?: string;
    upstream?: string;
    errorCode?: string;
    from?: string;
    to?: string;
    limit?: string;
    before?: string;
  }>;
}

export default async function RequestLogPage({ searchParams }: PageProps) {
  const { apiKeyId, model, endpoint, status, upstream, errorCode, from, to, limit, before } = await searchParams;

  const params = new URLSearchParams();
  if (apiKeyId) params.set("apiKeyId", apiKeyId);
  if (model) params.set("model", model);
  if (endpoint) params.set("endpoint", endpoint);
  if (status) params.set("status", status);
  if (upstream) params.set("upstream", upstream);
  if (errorCode) params.set("errorCode", errorCode);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", limit);
  if (before) params.set("before", before);

  const res = await fetchGatewayAdmin<RequestLogsListResponse>(`/request-logs?${params.toString()}`);

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.entries)) {
    return <ErrorPanel message={`Request logs could not be loaded. (Status: ${res.status})`} />;
  }

  const { entries, nextCursor } = res.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Request Logs</h1>
      </div>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Only request metadata is logged. Prompts and responses are never stored.
      </p>

      <RequestLogFilters
        initialFilters={{ apiKeyId, model, endpoint, status, upstream, errorCode, from, to, limit }}
      />

      <RequestLogTable
        initialEntries={entries}
        initialNextCursor={nextCursor}
        initialFilters={{ apiKeyId, model, endpoint, status, upstream, errorCode, from, to, limit }}
      />
    </div>
  );
}