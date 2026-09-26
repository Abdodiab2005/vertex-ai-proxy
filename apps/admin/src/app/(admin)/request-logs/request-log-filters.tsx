"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ALLOWED_ENDPOINTS, ENDPOINT_LABELS } from "../../../lib/types";

const selectClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-xs";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-md";

interface RequestLogFiltersProps {
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

export function RequestLogFilters({ initialFilters }: RequestLogFiltersProps) {
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
      router.push(`/request-logs?${params.toString()}`);
    },
    [router, searchParams],
  );

  return (
    <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-api-key-id" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          API Key ID
        </label>
        <input
          id="req-api-key-id"
          type="text"
          placeholder="UUID"
          value={initialFilters.apiKeyId ?? ""}
          onChange={(e) => updateParams({ apiKeyId: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-model" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Model
        </label>
        <input
          id="req-model"
          type="text"
          placeholder="e.g. gemini-1.5-pro"
          value={initialFilters.model ?? ""}
          onChange={(e) => updateParams({ model: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-endpoint" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Endpoint
        </label>
        <select
          id="req-endpoint"
          value={initialFilters.endpoint ?? ""}
          onChange={(e) => updateParams({ endpoint: e.target.value || undefined })}
          className={selectClassName}
        >
          <option value="">All endpoints</option>
          {ALLOWED_ENDPOINTS.map((ep) => (
            <option key={ep} value={ep}>
              {ENDPOINT_LABELS[ep]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-status" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Status
        </label>
        <select
          id="req-status"
          value={initialFilters.status ?? ""}
          onChange={(e) => updateParams({ status: e.target.value || undefined })}
          className={selectClassName}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="partial">Partial</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-upstream" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Upstream
        </label>
        <input
          id="req-upstream"
          type="text"
          placeholder="Upstream name"
          value={initialFilters.upstream ?? ""}
          onChange={(e) => updateParams({ upstream: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-error-code" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Error Code
        </label>
        <input
          id="req-error-code"
          type="text"
          placeholder="Error code"
          value={initialFilters.errorCode ?? ""}
          onChange={(e) => updateParams({ errorCode: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-from" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          From
        </label>
        <input
          id="req-from"
          type="datetime-local"
          value={initialFilters.from ?? ""}
          onChange={(e) => updateParams({ from: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-to" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          To
        </label>
        <input
          id="req-to"
          type="datetime-local"
          value={initialFilters.to ?? ""}
          onChange={(e) => updateParams({ to: e.target.value || undefined })}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="req-limit" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Limit
        </label>
        <select
          id="req-limit"
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