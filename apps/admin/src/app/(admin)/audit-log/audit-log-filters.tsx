"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

const selectClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-xs";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-md";

interface AuditLogFiltersProps {
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

export function AuditLogFilters({ initialFilters }: AuditLogFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateParams = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      params.delete("before");
      router.push(`/audit-log?${params.toString()}`);
    },
    [router, searchParams],
  );

  return (
    <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-action" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Action
        </label>
        <select
          id="audit-action"
          value={initialFilters.action ?? ""}
          onChange={(e) => updateParams({ action: e.target.value || undefined })}
          className={selectClassName}
        >
          <option value="">All actions</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-entity-type" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Entity type
        </label>
        <input
          id="audit-entity-type"
          type="text"
          placeholder="e.g. api_key, model, upstream"
          value={initialFilters.entityType ?? ""}
          onChange={(e) => updateParams({ entityType: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-entity-id" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Entity ID
        </label>
        <input
          id="audit-entity-id"
          type="text"
          placeholder="UUID"
          value={initialFilters.entityId ?? ""}
          onChange={(e) => updateParams({ entityId: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-admin-id" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Admin ID
        </label>
        <input
          id="audit-admin-id"
          type="text"
          placeholder="Admin UUID"
          value={initialFilters.adminUserId ?? ""}
          onChange={(e) => updateParams({ adminUserId: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-from" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          From
        </label>
        <input
          id="audit-from"
          type="datetime-local"
          value={initialFilters.from ?? ""}
          onChange={(e) => updateParams({ from: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-to" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          To
        </label>
        <input
          id="audit-to"
          type="datetime-local"
          value={initialFilters.to ?? ""}
          onChange={(e) => updateParams({ to: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-limit" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Limit
        </label>
        <select
          id="audit-limit"
          value={initialFilters.limit ?? "50"}
          onChange={(e) => updateParams({ limit: e.target.value || undefined })}
          className={selectClassName}
        >
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>
    </div>
  );
}