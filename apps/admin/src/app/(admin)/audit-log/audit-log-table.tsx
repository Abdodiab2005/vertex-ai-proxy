"use client";

import React from "react";
import { useState } from "react";
import { RelativeTime } from "../upstreams/relative-time";

interface AuditLogTableProps {
  initialEntries: Array<{
    id: string;
    action: string;
    adminUserId: string | null;
    adminEmail: string | null;
    entityType: string | null;
    entityId: string | null;
    ipAddress: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    createdAt: string;
  }>;
  initialNextCursor: string | null;
  initialFilters: {
    action?: string;
    entityType?: string;
    entityId?: string;
    adminUserId?: string;
    from?: string;
    to?: string;
    limit?: string;
  };
}

export function AuditLogTable({
  initialEntries,
  initialNextCursor,
  initialFilters,
}: AuditLogTableProps) {
  const [entries, setEntries] = useState(initialEntries);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const handleLoadMore = async () => {
    if (!nextCursor) return;

    const params = new URLSearchParams();
    if (initialFilters.action) params.set("action", initialFilters.action);
    if (initialFilters.entityType) params.set("entityType", initialFilters.entityType);
    if (initialFilters.entityId) params.set("entityId", initialFilters.entityId);
    if (initialFilters.adminUserId) params.set("adminUserId", initialFilters.adminUserId);
    if (initialFilters.from) params.set("from", initialFilters.from);
    if (initialFilters.to) params.set("to", initialFilters.to);
    if (initialFilters.limit) params.set("limit", initialFilters.limit);
    params.set("before", nextCursor);

    const res = await fetch(`/admin-api/audit-logs?${params.toString()}`, {
      cache: "no-store",
      credentials: "include",
    });

    if (res.ok) {
      const data = await res.json();
      setEntries((prev) => [...prev, ...data.entries]);
      setNextCursor(data.nextCursor);
    }
  };

  const formatEntity = (entry: { entityType: string | null; entityId: string | null }): string => {
    if (!entry.entityType) return "—";
    if (!entry.entityId) return entry.entityType;
    const shortId = entry.entityId.slice(0, 8);
    return `${entry.entityType} (${shortId}...)`;
  };

  const formatIp = (ip: string | null): string => {
    return ip ?? "—";
  };

  const formatAdmin = (entry: { adminEmail: string | null; adminUserId: string | null }): string => {
    return entry.adminEmail ?? (entry.adminUserId ? "deleted admin" : "system");
  };

  const prettyJson = (obj: Record<string, unknown> | null): string => {
    if (!obj) return "—";
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return "Invalid JSON";
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (entries.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center space-y-4">
        <p className="text-zinc-600 dark:text-zinc-400">No audit log entries found</p>
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
              <th className="px-4 py-3 font-medium whitespace-nowrap">Admin</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Action</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Entity</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">IP</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <React.Fragment key={entry.id}>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    <RelativeTime iso={entry.createdAt} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {formatAdmin(entry)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                    {entry.action}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                    {formatEntity(entry)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                    {formatIp(entry.ipAddress)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <button
                      onClick={() => toggleExpand(entry.id)}
                      className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 text-sm font-medium"
                      aria-expanded={expandedRows.has(entry.id)}
                      aria-controls={`details-${entry.id}`}
                    >
                      {expandedRows.has(entry.id) ? "Hide" : "Show"} details
                    </button>
                  </td>
                </tr>
                <tr id={`details-${entry.id}`} className={expandedRows.has(entry.id) ? "" : "hidden"}>
                  <td colSpan={6} className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-200 dark:border-zinc-800">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                      <div>
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Before</p>
                        <pre className="text-xs overflow-x-auto bg-zinc-100 dark:bg-zinc-900 p-3 rounded border border-zinc-200 dark:border-zinc-700 max-h-96">
                          {prettyJson(entry.before)}
                        </pre>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">After</p>
                        <pre className="text-xs overflow-x-auto bg-zinc-100 dark:bg-zinc-900 p-3 rounded border border-zinc-200 dark:border-zinc-700 max-h-96">
                          {prettyJson(entry.after)}
                        </pre>
                      </div>
                    </div>
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            onClick={handleLoadMore}
            disabled={!nextCursor}
            className="px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          >
            Older entries →
          </button>
        </div>
      )}
    </>
  );
}