"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchAdminApi, readResponseBody } from "../../lib/admin-api";
import type { AlertsListResponse, AlertView } from "../../lib/types";

interface AlertBellProps {
  initialCount: number;
  csrfToken: string;
}

export function AlertBell({ initialCount, csrfToken }: AlertBellProps) {
  const [count, setCount] = useState(initialCount);
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const res = await fetchAdminApi("/alerts?status=open&limit=5", {
          method: "GET",
          csrfToken,
        });
        if (res.ok) {
          const data = (await readResponseBody(res)) as AlertsListResponse | null;
          if (data) {
            setCount(data.counts.active);
            setAlerts(data.alerts);
          }
        }
      } catch {
        // Ignore errors - bell will show initial count
      }
    }

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(interval);
  }, [csrfToken]);

  const handleAcknowledge = async (alertId: string) => {
    try {
      const res = await fetchAdminApi(`/alerts/${alertId}/acknowledge`, {
        method: "POST",
        csrfToken,
        body: {},
      });
      if (res.ok) {
        setAlerts((prev) =>
          prev.map((a) => (a.id === alertId ? { ...a, status: "acknowledged" as const } : a)),
        );
        setCount((prev) => Math.max(0, prev - 1));
      }
    } catch {
      // Ignore
    }
  };

  const handleRunChecks = async () => {
    try {
      await fetchAdminApi("/alerts/evaluate", {
        method: "POST",
        csrfToken,
        body: {},
      });
      // Refresh alerts
      const res = await fetchAdminApi("/alerts?status=open&limit=5", {
        method: "GET",
        csrfToken,
      });
      if (res.ok) {
        const data = (await readResponseBody(res)) as AlertsListResponse | null;
        if (data) {
          setCount(data.counts.active);
          setAlerts(data.alerts);
        }
      }
    } catch {
      // Ignore
    }
  };

  if (count === 0 && alerts.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        aria-label={`Alerts (${count})`}
        aria-expanded={open}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-medium text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
      )}

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-96 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Alerts</h3>
            <button
              type="button"
              onClick={handleRunChecks}
              className="text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Run checks now
            </button>
          </div>

          {alerts.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No active alerts
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                        ALERT_SEVERITY_COLORS[alert.severity]
                      }`}
                    >
                      {alert.severity}
                    </span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                        ALERT_STATUS_COLORS[alert.status]
                      }`}
                    >
                      {ALERT_STATUS_LABELS[alert.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">{alert.title}</p>
                  <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{alert.message}</p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                    {new Date(alert.firstSeenAt).toLocaleString()}
                  </p>
                  {alert.status === "active" && (
                    <button
                      type="button"
                      onClick={() => handleAcknowledge(alert.id)}
                      className="mt-2 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-700">
            <Link
              href="/alerts"
              className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              onClick={() => setOpen(false)}
            >
              View all alerts
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// These constants need to be available in the client component
const ALERT_SEVERITY_COLORS: Record<"info" | "warning" | "critical", string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const ALERT_STATUS_COLORS: Record<"active" | "acknowledged" | "resolved", string> = {
  active: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  acknowledged: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  resolved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
};

const ALERT_STATUS_LABELS: Record<"active" | "acknowledged" | "resolved", string> = {
  active: "Active",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};