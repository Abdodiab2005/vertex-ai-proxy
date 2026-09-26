"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessageForStatus, fetchAdminApi, readResponseBody } from "../../../../lib/admin-api";
import { useAdminSession } from "../../admin-session";
import { FormError } from "../../form-alert";

const buttonClassName =
  "px-3 py-1.5 text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export function ResetCountersButton({ apiKeyId }: { apiKeyId: string }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [confirming, setConfirming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);

  const handleReset = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const res = await fetchAdminApi(`/api-keys/${encodeURIComponent(apiKeyId)}/reset-counters`, {
        method: "POST",
        csrfToken,
      });

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status === 204) {
        setConfirming(false);
        router.refresh();
        return;
      }

      const body = await readResponseBody(res);
      setError(errorMessageForStatus(res.status, body));
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <FormError error={error} />}
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={isLoading}
          className={`${buttonClassName} text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 focus:ring-zinc-500`}
        >
          Reset rate counters
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-zinc-700 dark:text-zinc-300">
            Reset the live rate counters? Usage history and credit stay unchanged.
          </span>
          <button
            type="button"
            onClick={handleReset}
            disabled={isLoading}
            className={`${buttonClassName} text-white bg-amber-600 hover:bg-amber-700 focus:ring-amber-500`}
          >
            {isLoading ? "Resetting..." : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isLoading}
            className={`${buttonClassName} text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 focus:ring-zinc-500`}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
