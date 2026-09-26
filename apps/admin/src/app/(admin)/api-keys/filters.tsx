"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  API_KEY_STATUS_LABELS,
  type ApiKeyStatus,
} from "../../../lib/types";

const selectClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-xs";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-md";

const STATUSES: readonly ApiKeyStatus[] = [
  "active",
  "suspended",
  "revoked",
  "expired",
  "credit_exhausted",
];

export function ApiKeyFilters({
  search,
  status,
}: {
  search?: string;
  status?: string;
}) {
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
      params.delete("page");
      router.push(`/api-keys?${params.toString()}`);
    },
    [router, searchParams],
  );

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateParams({ search: event.target.value || undefined });
  };

  const handleStatusChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    updateParams({ status: event.target.value || undefined });
  };

  return (
    <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-keys-search" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Search
        </label>
        <input
          id="api-keys-search"
          type="search"
          placeholder="Search by name or key prefix..."
          value={search ?? ""}
          onChange={handleSearchChange}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-keys-status" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Status
        </label>
        <select
          id="api-keys-status"
          value={status ?? ""}
          onChange={handleStatusChange}
          className={selectClassName}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {API_KEY_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}