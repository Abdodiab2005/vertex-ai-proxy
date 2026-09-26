"use client";

import React from "react";
import { useState } from "react";
import { RelativeTime } from "../upstreams/relative-time";
import { REQUEST_LOG_STATUS_LABELS, type RequestLogEntry } from "../../../lib/types";

interface RequestLogTableProps {
  initialEntries: RequestLogEntry[];
  initialNextCursor: string | null;
  initialFilters: {
    apiKeyId?: string;
    model?: string;
    endpoint?: string;
    status?: string;
    upstream?: string;
    errorCode?: string;
    from?: string;
    to?: string;
    limit?: string;
  };
}

export function RequestLogTable({
  initialEntries,
  initialNextCursor,
  initialFilters,
}: RequestLogTableProps) {
  const [entries, setEntries] = useState<RequestLogEntry[]>(initialEntries);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);

  // Built from the server-provided filters: reading window.location during render
  // would break server rendering of this client component.
  const exportQuery = new URLSearchParams(
    Object.entries(initialFilters).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  ).toString();
  const exportHref = `/admin-api/request-logs/export.csv${exportQuery ? `?${exportQuery}` : ""}`;

  const handleLoadMore = async () => {
    if (!nextCursor) return;

    const params = new URLSearchParams();
    if (initialFilters.apiKeyId) params.set("apiKeyId", initialFilters.apiKeyId);
    if (initialFilters.model) params.set("model", initialFilters.model);
    if (initialFilters.endpoint) params.set("endpoint", initialFilters.endpoint);
    if (initialFilters.status) params.set("status", initialFilters.status);
    if (initialFilters.upstream) params.set("upstream", initialFilters.upstream);
    if (initialFilters.errorCode) params.set("errorCode", initialFilters.errorCode);
    if (initialFilters.from) params.set("from", initialFilters.from);
    if (initialFilters.to) params.set("to", initialFilters.to);
    if (initialFilters.limit) params.set("limit", initialFilters.limit);
    params.set("before", nextCursor);

    const res = await fetch(`/admin-api/request-logs?${params.toString()}`, {
      cache: "no-store",
      credentials: "include",
    });

    if (res.ok) {
      const data = await res.json();
      setEntries((prev) => [...prev, ...data.entries]);
      setNextCursor(data.nextCursor);
    }
  };

  const formatStatus = (status: string) => {
    const label = REQUEST_LOG_STATUS_LABELS[status as keyof typeof REQUEST_LOG_STATUS_LABELS] ?? status;
    const className =
      status === "success"
        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
        : status === "error"
        ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
        : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";

    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${className}`}>
        {label}
      </span>
    );
  };

  const formatKey = (entry: RequestLogEntry) => {
    if (!entry.apiKeyName && !entry.apiKeyPrefix) return "—";
    if (!entry.apiKeyName) return entry.apiKeyPrefix;
    return `${entry.apiKeyName} (${entry.apiKeyPrefix})`;
  };

  if (entries.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center space-y-4">
        <p className="text-zinc-600 dark:text-zinc-400">No request log entries found</p>
        <a
          href={exportHref}
          className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        >
          Export CSV
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
        <table className="min-w-full text-sm text-start">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
              <th className="px-4 py-3 font-medium whitespace-nowrap">Time</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">API Key</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Model</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Endpoint</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Latency (ms)</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Input Tokens</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Output Tokens</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Cost</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Error Code</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                  <RelativeTime iso={entry.createdAt} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {formatKey(entry)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.model ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.endpoint}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{formatStatus(entry.status)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.latencyMs ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.inputTokens ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.outputTokens ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.calculatedCost ?? "—"}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                  {entry.errorCode ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        {nextCursor && (
          <button
            onClick={handleLoadMore}
            disabled={!nextCursor}
            className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          >
            Older entries →
          </button>
        )}

        <a
          href={exportHref}
          className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        >
          Export CSV
        </a>
      </div>
    </>
  );
}