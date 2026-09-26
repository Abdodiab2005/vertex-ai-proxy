"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessageForStatus, fetchAdminApi, readResponseBody } from "../../../lib/admin-api";
import { useAdminSession } from "../admin-session";
import { isEvaluateAlertsResponse, type AlertView, type AlertStatus, type AlertSeverity, type AlertStatusFilter } from "../../../lib/types";

interface AlertListProps {
  alerts: AlertView[];
  counts: { active: number; acknowledged: number };
  currentStatus: AlertStatusFilter;
}

export function AlertList({ alerts, counts, currentStatus }: AlertListProps) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const severityColors: Record<AlertSeverity, string> = {
    info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };

  const statusColors: Record<AlertStatus, string> = {
    active: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    acknowledged: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    resolved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  };

  const statusLabels: Record<AlertStatus, string> = {
    active: "Active",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
  };

  const handleAcknowledge = async (alertId: string) => {
    try {
      const res = await fetchAdminApi(`/alerts/${alertId}/acknowledge`, {
        method: "POST",
        csrfToken,
        body: {},
      });
      if (res.ok) {
        setNotice(null);
        router.refresh();
      } else {
        const message = errorMessageForStatus(res.status, await readResponseBody(res), "This alert no longer exists.");
        setNotice(Array.isArray(message) ? message.join(" ") : message);
      }
    } catch {
      setNotice("Something went wrong.")
    }
  };

  const handleRunChecks = async () => {
    setIsEvaluating(true);
    try {
      const res = await fetchAdminApi("/alerts/evaluate", {
        method: "POST",
        csrfToken,
        body: {},
      });
      const data = await readResponseBody(res);
      if (!isEvaluateAlertsResponse(data)) {
        setNotice(`Checks failed (HTTP ${res.status}).`);
      } else if (data.skipped) {
        setNotice("Another check is already running; try again in a minute.");
      } else {
        setNotice(`Checks done: ${data.created} new, ${data.resolved} resolved.`);
      }
      router.refresh();
    } catch {
      setNotice("Something went wrong.");
    } finally {
      setIsEvaluating(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      credit_80: "Credit 80%",
      credit_100: "Credit Exhausted",
      high_error_rate: "High Error Rate",
      upstream_unavailable: "Upstream Unavailable",
      spend_threshold: "Spend Threshold",
    };
    return labels[type] ?? type;
  };

  return (
    <div className="space-y-4">
      {/* Summary counts */}
      <div className="flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${
            statusColors.active
          }`}
        >
          Active: {counts.active}
        </span>
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium ${
            statusColors.acknowledged
          }`}
        >
          Acknowledged: {counts.acknowledged}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRunChecks}
          disabled={isEvaluating}
          className="px-3 py-1.5 text-sm border border-zinc-300 rounded-md bg-white text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isEvaluating ? "Running..." : "Run checks now"}
        </button>
        {notice && (
          <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
            {notice}
          </p>
        )}
      </div>

      {/* Alerts table */}
      {alerts.length === 0 ? (
        <div className="text-center py-12">
          <svg
            className="mx-auto h-12 w-12 text-zinc-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">No alerts</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {currentStatus === "open"
              ? "No active or acknowledged alerts. All systems operational."
              : `No ${statusLabels[currentStatus].toLowerCase()} alerts.`}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  Severity
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  Title
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  First Seen
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-700">
              {alerts.map((alert) => (
                <tr key={alert.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        severityColors[alert.severity]
                      }`}
                    >
                      {alert.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-900 dark:text-zinc-100">
                    {getTypeLabel(alert.type)}
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{alert.title}</p>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400 truncate max-w-xs">{alert.message}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        statusColors[alert.status]
                      }`}
                    >
                      {statusLabels[alert.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
                    {formatDate(alert.firstSeenAt)}
                  </td>
                  <td className="px-4 py-3">
                    {alert.status === "active" && (
                      <button
                        type="button"
                        onClick={() => handleAcknowledge(alert.id)}
                        className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                      >
                        Acknowledge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}