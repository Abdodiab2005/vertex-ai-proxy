"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  isModelSyncResponse,
  isRecord,
  type ModelSyncSummary,
  type UpstreamView,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { FormError } from "../form-alert";

const selectClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full max-w-full";

const buttonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export function SyncModels({ upstreams }: { upstreams: UpstreamView[] | null }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [upstreamId, setUpstreamId] = useState(upstreams?.[0]?.id ?? "");
  const [error, setError] = useState<string | string[] | null>(null);
  const [summary, setSummary] = useState<ModelSyncSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedId =
    upstreams?.some((upstream) => upstream.id === upstreamId) === true
      ? upstreamId
      : (upstreams?.[0]?.id ?? "");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedId === "") {
      return;
    }
    setError(null);
    setSummary(null);
    setIsSubmitting(true);

    try {
      const res = await fetchAdminApi("/models/sync", {
        method: "POST",
        csrfToken,
        body: { upstreamId: selectedId },
      });
      const body = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 200 || !isModelSyncResponse(body)) {
        setError(syncFailureMessage(res.status, body));
        return;
      }

      setSummary(body.summary);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Sync models</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Imports Gemini and text-embedding models. Existing names, pricing, and the enabled state
          are kept.
        </p>
      </div>

      {upstreams === null ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Upstreams could not be loaded.
        </p>
      ) : upstreams.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No upstreams yet.{" "}
          <Link
            href="/upstreams/new"
            className="text-zinc-900 dark:text-zinc-100 underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
          >
            Add an upstream
          </Link>
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <label htmlFor="sync-upstream" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Upstream
            </label>
            <select
              id="sync-upstream"
              name="upstreamId"
              value={selectedId}
              onChange={(event) => setUpstreamId(event.target.value)}
              disabled={isSubmitting}
              className={selectClassName}
            >
              {upstreams.map((upstream) => (
                <option key={upstream.id} value={upstream.id}>
                  {upstream.name} ({upstream.provider})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={isSubmitting || selectedId === ""} className={buttonClassName}>
            {isSubmitting ? "Syncing..." : "Sync"}
          </button>
        </form>
      )}

      {error && <FormError error={error} />}
      {summary && <SyncSummary summary={summary} />}
    </section>
  );
}

function SyncSummary({ summary }: { summary: ModelSyncSummary }) {
  return (
    <div aria-live="polite" className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-4">
      <p className="text-sm text-zinc-800 dark:text-zinc-200">Discovered {summary.discovered}.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <NameList title="Created" items={summary.created} />
        <NameList title="Marked available" items={summary.markedAvailable} />
        <NameList title="Marked unavailable" items={summary.markedUnavailable} />
        <NameList title="Conflicts" items={summary.conflicts} />
      </div>
    </div>
  );
}

function NameList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">None</p>
      ) : (
        <ul className="list-disc ps-5 text-sm text-zinc-800 dark:text-zinc-200">
          {items.map((item, index) => (
            <li key={`${item}-${index}`} className="break-all">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function syncFailureMessage(status: number, body: unknown): string | string[] {
  if ((status === 502 || status === 404) && isRecord(body)) {
    const message = body.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return errorMessageForStatus(status, body, "Upstream not found.");
}
