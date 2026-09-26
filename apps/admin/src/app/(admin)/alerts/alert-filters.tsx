"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { AlertStatusFilter } from "../../../lib/types";

interface AlertFiltersProps {
  currentStatus: AlertStatusFilter;
}

export function AlertFilters({ currentStatus }: AlertFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const statusOptions: { value: AlertStatusFilter; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "active", label: "Active" },
    { value: "acknowledged", label: "Acknowledged" },
    { value: "resolved", label: "Resolved" },
  ];

  const handleStatusChange = (value: AlertStatusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("status", value);
    router.push(`/alerts?${params.toString()}`);
  };

  return (
    <select
      value={currentStatus}
      onChange={(e) => handleStatusChange(e.target.value as AlertStatusFilter)}
      className="px-3 py-1.5 text-sm border border-zinc-300 rounded-md bg-white text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
    >
      {statusOptions.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}