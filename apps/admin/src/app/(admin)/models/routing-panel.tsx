"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessageForStatus, fetchAdminApi, readResponseBody } from "../../../lib/admin-api";
import { useAdminSession } from "../admin-session";
import type { ModelRoutesResponse, ModelView, RoutingStrategy, UpstreamView } from "../../../lib/types";
import { FormError } from "../form-alert";

const STRATEGIES: { value: RoutingStrategy; label: string; description: string }[] = [
  {
    value: "priority",
    label: "Priority",
    description: "Every request goes to the enabled route with the lowest priority number. No retries.",
  },
  {
    value: "fallback",
    label: "Fallback",
    description:
      "Lowest number first. If it fails with a network, quota or 5xx error before answering, the next route is tried (up to 3 in total). Never retried: invalid requests, safety blocks, auth errors, cancelled requests.",
  },
  {
    value: "round_robin",
    label: "Round robin",
    description: "Requests rotate across all enabled routes in turn.",
  },
  {
    value: "manual",
    label: "Manual",
    description: "Pinned to the top route only; the others are kept but never used.",
  },
];

const fieldClassName =
  "px-2 py-1.5 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50";

const buttonClassName =
  "px-3 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const secondaryButtonClassName =
  "px-3 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-200 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50";

type RouteRow = {
  upstreamId: string;
  priority: string;
  enabled: boolean;
  isDefault: boolean;
};

function rowsFrom(routes: ModelRoutesResponse["routes"]): RouteRow[] {
  return routes.map((route) => ({
    upstreamId: route.upstreamId,
    priority: String(route.priority),
    enabled: route.enabled,
    isDefault: route.isDefault,
  }));
}

export function RoutingPanel({
  model,
  routing,
  upstreams,
}: {
  model: ModelView;
  routing: ModelRoutesResponse;
  upstreams: UpstreamView[];
}) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [strategy, setStrategy] = useState<RoutingStrategy>(routing.strategy);
  const [rows, setRows] = useState<RouteRow[]>(() => rowsFrom(routing.routes));
  const [adding, setAdding] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const upstreamById = new Map(upstreams.map((upstream) => [upstream.id, upstream]));
  const available = upstreams.filter((upstream) => !rows.some((row) => row.upstreamId === upstream.id));
  const selected = STRATEGIES.find((option) => option.value === strategy);

  const update = (upstreamId: string, patch: Partial<RouteRow>) => {
    setSaved(false);
    setRows((current) => current.map((row) => (row.upstreamId === upstreamId ? { ...row, ...patch } : row)));
  };

  const handleSave = async () => {
    setError(null);
    setSaved(false);
    const invalid = rows.find((row) => !/^\d{1,4}$/.test(row.priority) || Number(row.priority) > 1000);
    if (invalid) {
      setError("Priorities must be whole numbers from 0 to 1000.");
      return;
    }

    // The model's own upstream is an implicit route at priority 0; only store it when it differs.
    const body = {
      strategy,
      routes: rows
        .filter((row) => !row.isDefault || row.priority !== "0" || !row.enabled)
        .map((row) => ({ upstreamId: row.upstreamId, priority: Number(row.priority), enabled: row.enabled })),
    };

    setIsSaving(true);
    try {
      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/routes`, {
        method: "PUT",
        csrfToken,
        body,
      });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      const data = await readResponseBody(res);
      if (res.status !== 200) {
        setError(errorMessageForStatus(res.status, data, "This model no longer exists."));
        return;
      }
      const next = data as ModelRoutesResponse;
      setStrategy(next.strategy);
      setRows(rowsFrom(next.routes));
      setSaved(true);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Routing</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Serve this model from more than one Vertex upstream. The same upstream model name is used on each.
        </p>
      </div>

      {error && <FormError error={error} />}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="routing-strategy" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Strategy
        </label>
        <select
          id="routing-strategy"
          value={strategy}
          onChange={(e) => {
            setSaved(false);
            setStrategy(e.target.value as RoutingStrategy);
          }}
          disabled={isSaving}
          className={`${fieldClassName} max-w-xs`}
        >
          {STRATEGIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selected && <p className="text-xs text-zinc-500 dark:text-zinc-400">{selected.description}</p>}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500 dark:text-zinc-400">
              <th className="py-2 pr-4 font-medium">Upstream</th>
              <th className="py-2 pr-4 font-medium">Priority</th>
              <th className="py-2 pr-4 font-medium">Route</th>
              <th className="py-2 pr-4 font-medium">Upstream status</th>
              <th className="py-2 font-medium sr-only">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => {
              const upstream = upstreamById.get(row.upstreamId);
              const name = upstream?.name ?? routing.routes.find((r) => r.upstreamId === row.upstreamId)?.upstreamName ?? row.upstreamId;
              return (
                <tr key={row.upstreamId}>
                  <td className="py-2 pr-4 text-zinc-900 dark:text-zinc-100">
                    {name}
                    {row.isDefault && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">(model&apos;s upstream)</span>}
                  </td>
                  <td className="py-2 pr-4">
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      aria-label={`Priority for ${name}`}
                      value={row.priority}
                      onChange={(e) => update(row.upstreamId, { priority: e.target.value })}
                      disabled={isSaving}
                      className={`${fieldClassName} w-24`}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <label className="inline-flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => update(row.upstreamId, { enabled: e.target.checked })}
                        disabled={isSaving}
                      />
                      Enabled
                    </label>
                  </td>
                  <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                    {upstream ? `${upstream.enabled ? "enabled" : "disabled"} · ${upstream.status}` : "unknown"}
                  </td>
                  <td className="py-2 text-right">
                    {!row.isDefault && (
                      <button
                        type="button"
                        onClick={() => {
                          setSaved(false);
                          setRows((current) => current.filter((r) => r.upstreamId !== row.upstreamId));
                        }}
                        disabled={isSaving}
                        className="text-xs text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded p-1"
                        aria-label={`Remove route to ${name}`}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routing-add" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Add route
          </label>
          <select
            id="routing-add"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            disabled={isSaving || available.length === 0}
            className={`${fieldClassName} min-w-48`}
          >
            <option value="">{available.length === 0 ? "No other upstreams" : "Choose an upstream"}</option>
            {available.map((upstream) => (
              <option key={upstream.id} value={upstream.id}>
                {upstream.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={isSaving || adding === ""}
          onClick={() => {
            const lowest = rows.reduce((max, row) => Math.max(max, Number(row.priority) || 0), 0);
            setSaved(false);
            setRows((current) => [...current, { upstreamId: adding, priority: String(Math.min(lowest + 10, 1000)), enabled: true, isDefault: false }]);
            setAdding("");
          }}
          className={secondaryButtonClassName}
        >
          Add
        </button>
        <div className="flex-1" />
        {saved && <span className="text-sm text-green-700 dark:text-green-400">Saved.</span>}
        <button type="button" onClick={handleSave} disabled={isSaving} className={buttonClassName}>
          {isSaving ? "Saving…" : "Save routing"}
        </button>
      </div>
    </div>
  );
}
