"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../../lib/admin-api";
import { type ApiKeyView, isApiKeyResponse, isCreateApiKeyResponse } from "../../../../lib/types";
import { useAdminSession } from "../../admin-session";
import { FormError } from "../../form-alert";
import { ApiKeyStatusBadge } from "../status-badge";

const buttonClassName =
  "px-3 py-1.5 text-sm font-medium rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const suspendButtonClassName = `${buttonClassName} text-white bg-amber-600 hover:bg-amber-700 focus:ring-amber-500`;
const reactivateButtonClassName = `${buttonClassName} text-white bg-green-600 hover:bg-green-700 focus:ring-green-500`;
const revokeButtonClassName = `${buttonClassName} text-white bg-red-600 hover:bg-red-700 focus:ring-red-500`;
const neutralButtonClassName = `${buttonClassName} text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 focus:ring-zinc-500`;

const DELETE_BLOCKED_MESSAGE =
  "Keys with usage or credit history can't be deleted. Revoke the key instead.";

type ApiKeyStatusActionsProps = {
  apiKey: ApiKeyView;
  deletable: boolean;
};

export function ApiKeyStatusActions({ apiKey, deletable }: ApiKeyStatusActionsProps) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [error, setError] = useState<string | string[] | null>(null);
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleAction = async (action: "suspend" | "reactivate" | "revoke") => {
    setError(null);
    setIsLoading(action);

    try {
      const res = await fetchAdminApi(
        `/api-keys/${encodeURIComponent(apiKey.id)}/${action}`,
        {
          method: "POST",
          csrfToken,
        },
      );
      const body = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status === 409) {
        setError(errorMessageForStatus(res.status, body, "Invalid status transition."));
        return;
      }

      if ((res.status !== 200 && res.status !== 201) || !isApiKeyResponse(body)) {
        setError(errorMessageForStatus(res.status, body));
        return;
      }

      setShowRevokeConfirm(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(null);
    }
  };

  const handleRegenerate = async () => {
    setError(null);
    setCopied(false);
    setIsLoading("regenerate");

    try {
      const res = await fetchAdminApi(`/api-keys/${encodeURIComponent(apiKey.id)}/regenerate`, {
        method: "POST",
        csrfToken,
      });
      const body = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 200 || !isCreateApiKeyResponse(body)) {
        setError(errorMessageForStatus(res.status, body));
        return;
      }

      setRawKey(body.rawKey);
      setShowRegenerateConfirm(false);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(null);
    }
  };

  const handleDelete = async () => {
    setError(null);
    setIsLoading("delete");

    try {
      const res = await fetchAdminApi(`/api-keys/${encodeURIComponent(apiKey.id)}`, {
        method: "DELETE",
        csrfToken,
      });

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status === 204) {
        router.push("/api-keys");
        router.refresh();
        return;
      }

      const body = await readResponseBody(res);
      setError(errorMessageForStatus(res.status, body));
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsLoading(null);
    }
  };

  const handleCopy = async () => {
    if (rawKey === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
    } catch {
      setError("Could not copy the key. Select it and copy it manually.");
    }
  };

  const canSuspend = apiKey.status === "active";
  const canReactivate = apiKey.status === "suspended";
  const canRevoke = apiKey.status !== "revoked";
  const canRegenerate = apiKey.status !== "revoked";
  const busy = isLoading !== null;

  return (
    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Current status:</span>
        <ApiKeyStatusBadge status={apiKey.status} />
      </div>

      {error && <FormError error={error} />}

      {rawKey !== null && (
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Copy this key now. It will not be shown again.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="regenerated-raw-key" className="sr-only">
              New raw key
            </label>
            <input
              id="regenerated-raw-key"
              type="text"
              readOnly
              value={rawKey}
              dir="ltr"
              className="px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 font-mono w-full"
            />
            <button type="button" onClick={handleCopy} className={neutralButtonClassName}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setRawKey(null);
              setCopied(false);
              router.refresh();
            }}
            className={neutralButtonClassName}
          >
            Done
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canSuspend && (
          <button
            type="button"
            onClick={() => handleAction("suspend")}
            disabled={busy}
            className={suspendButtonClassName}
          >
            {isLoading === "suspend" ? "Suspending..." : "Suspend"}
          </button>
        )}

        {canReactivate && (
          <button
            type="button"
            onClick={() => handleAction("reactivate")}
            disabled={busy}
            className={reactivateButtonClassName}
          >
            {isLoading === "reactivate" ? "Reactivating..." : "Reactivate"}
          </button>
        )}

        {canRevoke && !showRevokeConfirm && (
          <button
            type="button"
            onClick={() => {
              setShowRevokeConfirm(true);
              setShowRegenerateConfirm(false);
              setShowDeleteConfirm(false);
            }}
            disabled={busy}
            className={revokeButtonClassName}
          >
            Revoke
          </button>
        )}

        {canRevoke && showRevokeConfirm && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">Revoke permanently?</span>
            <button
              type="button"
              onClick={() => handleAction("revoke")}
              disabled={busy}
              className={revokeButtonClassName}
            >
              {isLoading === "revoke" ? "Revoking..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setShowRevokeConfirm(false)}
              disabled={busy}
              className={neutralButtonClassName}
            >
              Cancel
            </button>
          </div>
        )}

        {canRegenerate && !showRegenerateConfirm && (
          <button
            type="button"
            onClick={() => {
              setShowRegenerateConfirm(true);
              setShowRevokeConfirm(false);
              setShowDeleteConfirm(false);
            }}
            disabled={busy}
            className={neutralButtonClassName}
          >
            Regenerate
          </button>
        )}

        {canRegenerate && showRegenerateConfirm && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Generate a new secret? The current secret stops working immediately. Balance, usage, limits, and status stay the same.
            </span>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={busy}
              className={neutralButtonClassName}
            >
              {isLoading === "regenerate" ? "Regenerating..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setShowRegenerateConfirm(false)}
              disabled={busy}
              className={neutralButtonClassName}
            >
              Cancel
            </button>
          </div>
        )}

        {deletable && !showDeleteConfirm && (
          <button
            type="button"
            onClick={() => {
              setShowDeleteConfirm(true);
              setShowRevokeConfirm(false);
              setShowRegenerateConfirm(false);
            }}
            disabled={busy}
            className={revokeButtonClassName}
          >
            Delete
          </button>
        )}

        {deletable && showDeleteConfirm && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Delete this key permanently? This cannot be undone.
            </span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className={revokeButtonClassName}
            >
              {isLoading === "delete" ? "Deleting..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={busy}
              className={neutralButtonClassName}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {!deletable && <p className="text-sm text-zinc-600 dark:text-zinc-400">{DELETE_BLOCKED_MESSAGE}</p>}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Suspend temporarily disables the key. Reactivate restores a suspended key. Revoke permanently disables the key and cannot be undone.
      </p>
    </div>
  );
}
