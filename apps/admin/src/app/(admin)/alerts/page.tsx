import { fetchGatewayAdmin } from "../../../lib/gateway";
import type { AlertsListResponse, AlertView, AlertStatusFilter } from "../../../lib/types";
import { AlertList } from "./alert-list";
import { AlertFilters } from "./alert-filters";

interface AlertsPageProps {
  searchParams: Promise<{
    status?: string;
    limit?: string;
  }>;
}

export default async function AlertsPage({ searchParams }: AlertsPageProps) {
  const params = await searchParams;
  const status = (params.status as AlertStatusFilter | undefined) ?? "open";
  const limit = params.limit ? parseInt(params.limit, 10) : 50;

  const res = await fetchGatewayAdmin<AlertsListResponse>(
    `/alerts?status=${status}&limit=${limit}`,
  );

  let alerts: AlertView[] = [];
  let counts = { active: 0, acknowledged: 0 };

  if (res.status === 200 && res.data) {
    alerts = res.data.alerts;
    counts = res.data.counts;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Alerts</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Monitor and manage operational alerts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AlertFilters currentStatus={status} />
        </div>
      </div>

      <AlertList alerts={alerts} counts={counts} currentStatus={status} />
    </div>
  );
}