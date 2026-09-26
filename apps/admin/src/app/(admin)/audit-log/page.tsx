import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import type { AuditLogsListResponse } from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { AuditLogTable } from "./audit-log-table";
import { AuditLogFilters } from "./audit-log-filters";

interface PageProps {
  searchParams: Promise<{
    action?: string;
    entityType?: string;
    entityId?: string;
    adminUserId?: string;
    from?: string;
    to?: string;
    limit?: string;
    before?: string;
  }>;
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  const { action, entityType, entityId, adminUserId, from, to, limit, before } = await searchParams;

  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (entityType) params.set("entityType", entityType);
  if (entityId) params.set("entityId", entityId);
  if (adminUserId) params.set("adminUserId", adminUserId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", limit);
  if (before) params.set("before", before);

  const res = await fetchGatewayAdmin<AuditLogsListResponse>(`/audit-logs?${params.toString()}`);

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.entries)) {
    return <ErrorPanel message={`Audit logs could not be loaded. (Status: ${res.status})`} />;
  }

  const { entries, nextCursor } = res.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Audit Log</h1>
      </div>

      <AuditLogFilters
        initialFilters={{ action, entityType, entityId, adminUserId, from, to, limit }}
      />

      <AuditLogTable
        initialEntries={entries}
        initialNextCursor={nextCursor}
        initialFilters={{ action, entityType, entityId, adminUserId, from, to, limit }}
      />
    </div>
  );
}