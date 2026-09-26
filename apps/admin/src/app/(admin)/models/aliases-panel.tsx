"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessageForStatus, fetchAdminApi } from "../../../lib/admin-api";
import { useAdminSession } from "../admin-session";
import type { ModelView } from "../../../lib/types";
import { FormError } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 flex-1 min-w-0";

const buttonClassName =
  "px-3 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0";

const removeButtonClassName =
  "text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded p-1";

export function AliasesPanel({ model }: { model: ModelView }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  
  const [alias, setAlias] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!alias.trim()) return;
    
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/aliases`, {
        method: "POST",
        csrfToken,
        body: { alias: alias.trim() },
      });

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 201) {
        let msg = "Failed to add alias";
        try {
          const body = await res.json();
          msg = typeof errorMessageForStatus(res.status, body) === "string" ? errorMessageForStatus(res.status, body) as string : msg;
        } catch {}
        setError(msg);
        return;
      }

      setAlias("");
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (aliasToRemove: string) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/aliases/${encodeURIComponent(aliasToRemove)}`, {
        method: "DELETE",
        csrfToken,
      });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      setConfirming(null);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl">
      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Aliases</h3>
      
      {error && <FormError error={error} />}

      <ul className="space-y-2">
        {model.aliases.map((a) => (
          <li key={a} className="flex items-center justify-between p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded-md border border-zinc-200 dark:border-zinc-700">
            <span className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">{a}</span>
            {confirming === a ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600 dark:text-red-400">Sure?</span>
                <button
                  type="button"
                  onClick={() => handleRemove(a)}
                  disabled={isSubmitting}
                  className="px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 disabled:opacity-50"
                >
                  Yes, remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  disabled={isSubmitting}
                  className="px-2 py-1 text-xs font-medium text-zinc-700 bg-zinc-200 rounded hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(a)}
                disabled={isSubmitting}
                className={removeButtonClassName}
                aria-label={`Remove alias ${a}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </li>
        ))}
        {model.aliases.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">No aliases yet.</p>
        )}
      </ul>

      <form onSubmit={handleAdd} className="flex gap-2 items-end pt-2">
        <div className="flex-1 flex flex-col gap-1.5">
          <label htmlFor="new-alias" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Add alias</label>
          <input
            id="new-alias"
            type="text"
            required
            pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
            placeholder="e.g. gpt-4-turbo"
          />
        </div>
        <button type="submit" disabled={isSubmitting || !alias.trim()} className={buttonClassName}>
          Add
        </button>
      </form>
    </div>
  );
}
