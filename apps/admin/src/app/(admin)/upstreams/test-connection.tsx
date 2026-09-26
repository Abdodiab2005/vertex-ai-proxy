"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  isTestUpstreamResponse,
  type TestUpstreamResponse,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { FormError } from "../form-alert";
import { RelativeTime } from "./relative-time";
import { StatusBadge } from "./status-badge";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

export function TestConnection({ upstreamId }: { upstreamId: string }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [model, setModel] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [result, setResult] = useState<TestUpstreamResponse["result"] | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsTesting(true);

    try {
      const res = await fetchAdminApi(
        `/upstreams/${encodeURIComponent(upstreamId)}/test`,
        {
          method: "POST",
          csrfToken,
          body: { model: model.trim() },
        },
      );
      const body = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 200 || !isTestUpstreamResponse(body)) {
        setError(errorMessageForStatus(res.status, body));
        return;
      }

      setResult(body.result);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <FormError error={error} />}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="test-model" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Model
          </label>
          <input
            id="test-model"
            name="model"
            type="text"
            required
            maxLength={200}
            placeholder="e.g. gemini-2.5-flash"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={isTesting}
            className={inputClassName}
          />
        </div>
        <button
          type="submit"
          disabled={isTesting}
          className="px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isTesting ? "Testing..." : "Test"}
        </button>
      </form>

      {result && (
        <div className="space-y-2 border-t border-zinc-200 dark:border-zinc-800 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={result.status} />
            {result.httpStatus !== null && (
              <span className="text-sm text-zinc-600 dark:text-zinc-400">HTTP {result.httpStatus}</span>
            )}
          </div>
          <p className="text-sm text-zinc-800 dark:text-zinc-200">{result.message}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Checked <RelativeTime iso={result.checkedAt} />
          </p>
        </div>
      )}
    </div>
  );
}
