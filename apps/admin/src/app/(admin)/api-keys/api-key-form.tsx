"use client";

import { useRouter } from "next/navigation";
import { useState, useCallback } from "react";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  type CreateApiKeyRequest,
  type PatchApiKeyRequest,
  type ApiKeyView,
  type AllowedEndpoint,
  isCreateApiKeyResponse,
  isApiKeyResponse,
  ALLOWED_ENDPOINTS,
  ENDPOINT_LABELS,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { FormAlert, FormError } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const primaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const secondaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

function parseStringArray(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stringArrayToText(arr: string[]): string {
  return arr.join(", ");
}

type ApiKeyFormProps =
  | { mode: "create"; apiKey?: never }
  | { mode: "edit"; apiKey: ApiKeyView };

export function ApiKeyForm(props: ApiKeyFormProps) {
  const { mode, apiKey: initialApiKey } = props;
  const router = useRouter();
  const { csrfToken } = useAdminSession();

  const initial = mode === "edit" ? initialApiKey : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [expiresAt, setExpiresAt] = useState("");
  const [allowedModels, setAllowedModels] = useState(initial?.allowedModels ?? []);
  const [blockedModels, setBlockedModels] = useState(initial?.blockedModels ?? []);
  const [allowedEndpoints, setAllowedEndpoints] = useState<AllowedEndpoint[]>(
    initial?.allowedEndpoints ?? [...ALLOWED_ENDPOINTS],
  );
  const [requestsPerMinute, setRequestsPerMinute] = useState<string>(
    String(initial?.requestsPerMinute ?? ""),
  );
  const [requestsPerDay, setRequestsPerDay] = useState<string>(
    String(initial?.requestsPerDay ?? ""),
  );
  const [tokensPerMinute, setTokensPerMinute] = useState<string>(
    String(initial?.tokensPerMinute ?? ""),
  );
  const [tokensPerDay, setTokensPerDay] = useState<string>(
    String(initial?.tokensPerDay ?? ""),
  );
  const [tokensPerMonth, setTokensPerMonth] = useState<string>(
    String(initial?.tokensPerMonth ?? ""),
  );
  const [maxConcurrentRequests, setMaxConcurrentRequests] = useState<string>(
    String(initial?.maxConcurrentRequests ?? ""),
  );
  const [allowedIPs, setAllowedIPs] = useState(initial?.allowedIPs ?? []);
  const [blockedIPs, setBlockedIPs] = useState(initial?.blockedIPs ?? []);
  const [tags, setTags] = useState(initial?.tags ?? []);

  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdKey, setCreatedKey] = useState<{
    apiKey: ApiKeyView;
    rawKey: string;
  } | null>(null);

  const handleAllowedModelsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setAllowedModels(parseStringArray(event.target.value));
    },
    [],
  );

  const handleBlockedModelsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setBlockedModels(parseStringArray(event.target.value));
    },
    [],
  );

  const handleAllowedIPsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setAllowedIPs(parseStringArray(event.target.value));
    },
    [],
  );

  const handleBlockedIPsChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setBlockedIPs(parseStringArray(event.target.value));
    },
    [],
  );

  const handleTagsChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setTags(parseStringArray(event.target.value));
    },
    [],
  );

  const handleEndpointChange = useCallback(
    (endpoint: AllowedEndpoint, checked: boolean) => {
      setAllowedEndpoints((prev) =>
        checked
          ? [...prev, endpoint]
          : prev.filter((e) => e !== endpoint),
      );
    },
    [],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const expiresAtValue = expiresAt.trim();
    const expiresAtIso =
      expiresAtValue === "" ? undefined : new Date(expiresAtValue).toISOString();

    const body: CreateApiKeyRequest | PatchApiKeyRequest = {
      name: name.trim(),
      description: description.trim() || undefined,
      allowedModels:
        allowedModels.length > 0 ? allowedModels : undefined,
      blockedModels:
        blockedModels.length > 0 ? blockedModels : undefined,
      allowedEndpoints:
        allowedEndpoints.length > 0 && allowedEndpoints.length < ALLOWED_ENDPOINTS.length
          ? allowedEndpoints
          : undefined,
      expiresAt: expiresAtIso,
      requestsPerMinute:
        requestsPerMinute !== "" ? Number(requestsPerMinute) : undefined,
      requestsPerDay:
        requestsPerDay !== "" ? Number(requestsPerDay) : undefined,
      tokensPerMinute:
        tokensPerMinute !== "" ? Number(tokensPerMinute) : undefined,
      tokensPerDay:
        tokensPerDay !== "" ? Number(tokensPerDay) : undefined,
      tokensPerMonth:
        tokensPerMonth !== "" ? Number(tokensPerMonth) : undefined,
      maxConcurrentRequests:
        maxConcurrentRequests !== "" ? Number(maxConcurrentRequests) : undefined,
      allowedIPs: allowedIPs.length > 0 ? allowedIPs : undefined,
      blockedIPs: blockedIPs.length > 0 ? blockedIPs : undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    // Remove undefined values
    Object.keys(body).forEach(
      (key) =>
        body[key as keyof typeof body] === undefined &&
        delete body[key as keyof typeof body],
    );

    setIsSubmitting(true);

    try {
      if (mode === "create") {
        const res = await fetchAdminApi("/api-keys", {
          method: "POST",
          csrfToken,
          body,
        });
        const responseBody = await readResponseBody(res);

        if (res.status === 401) {
          router.replace("/login");
          router.refresh();
          return;
        }

        if (res.status !== 201 || !isCreateApiKeyResponse(responseBody)) {
          setError(errorMessageForStatus(res.status, responseBody));
          return;
        }

        setCreatedKey(responseBody);
        return;
      }

      const editBody: PatchApiKeyRequest = {};
      if (name.trim() !== initial?.name) {
        editBody.name = name.trim();
      }
      if (description.trim() !== (initial?.description ?? "")) {
        editBody.description = description.trim() || null;
      }
      if (
        allowedModels.length !== (initial?.allowedModels?.length ?? 0) ||
        !allowedModels.every((m: string, i: number) => m === initial?.allowedModels?.[i])
      ) {
        editBody.allowedModels = allowedModels.length > 0 ? allowedModels : [];
      }
      if (
        blockedModels.length !== (initial?.blockedModels?.length ?? 0) ||
        !blockedModels.every((m: string, i: number) => m === initial?.blockedModels?.[i])
      ) {
        editBody.blockedModels = blockedModels.length > 0 ? blockedModels : [];
      }
      if (
        allowedEndpoints.length !== (initial?.allowedEndpoints?.length ?? 0) ||
        !allowedEndpoints.every((e: AllowedEndpoint, i: number) => e === initial?.allowedEndpoints?.[i])
      ) {
        editBody.allowedEndpoints =
          allowedEndpoints.length > 0 && allowedEndpoints.length < ALLOWED_ENDPOINTS.length
            ? allowedEndpoints
            : [...ALLOWED_ENDPOINTS];
      }
      const newExpiresAt =
        expiresAtValue === "" ? null : expiresAtIso;
      if (newExpiresAt !== (initial?.expiresAt ?? null)) {
        editBody.expiresAt = newExpiresAt;
      }
      const newRequestsPerMinute =
        requestsPerMinute !== "" ? Number(requestsPerMinute) : null;
      if (newRequestsPerMinute !== (initial?.requestsPerMinute ?? null)) {
        editBody.requestsPerMinute = newRequestsPerMinute;
      }
      const newRequestsPerDay =
        requestsPerDay !== "" ? Number(requestsPerDay) : null;
      if (newRequestsPerDay !== (initial?.requestsPerDay ?? null)) {
        editBody.requestsPerDay = newRequestsPerDay;
      }
      const newTokensPerMinute =
        tokensPerMinute !== "" ? Number(tokensPerMinute) : null;
      if (newTokensPerMinute !== (initial?.tokensPerMinute ?? null)) {
        editBody.tokensPerMinute = newTokensPerMinute;
      }
      const newTokensPerDay =
        tokensPerDay !== "" ? Number(tokensPerDay) : null;
      if (newTokensPerDay !== (initial?.tokensPerDay ?? null)) {
        editBody.tokensPerDay = newTokensPerDay;
      }
      const newTokensPerMonth =
        tokensPerMonth !== "" ? Number(tokensPerMonth) : null;
      if (newTokensPerMonth !== (initial?.tokensPerMonth ?? null)) {
        editBody.tokensPerMonth = newTokensPerMonth;
      }
      const newMaxConcurrentRequests =
        maxConcurrentRequests !== "" ? Number(maxConcurrentRequests) : null;
      if (newMaxConcurrentRequests !== (initial?.maxConcurrentRequests ?? null)) {
        editBody.maxConcurrentRequests = newMaxConcurrentRequests;
      }
      if (
        allowedIPs.length !== (initial?.allowedIPs?.length ?? 0) ||
        !allowedIPs.every((ip: string, i: number) => ip === initial?.allowedIPs?.[i])
      ) {
        editBody.allowedIPs = allowedIPs.length > 0 ? allowedIPs : [];
      }
      if (
        blockedIPs.length !== (initial?.blockedIPs?.length ?? 0) ||
        !blockedIPs.every((ip: string, i: number) => ip === initial?.blockedIPs?.[i])
      ) {
        editBody.blockedIPs = blockedIPs.length > 0 ? blockedIPs : [];
      }
      if (
        tags.length !== (initial?.tags?.length ?? 0) ||
        !tags.every((t: string, i: number) => t === initial?.tags?.[i])
      ) {
        editBody.tags = tags.length > 0 ? tags : [];
      }

      if (Object.keys(editBody).length === 0) {
        setSuccess("No changes to save.");
        return;
      }

      const res = await fetchAdminApi(
        `/api-keys/${encodeURIComponent(initial!.id)}`,
        {
          method: "PATCH",
          csrfToken,
          body: editBody,
        },
      );
      const responseBody = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 200 || !isApiKeyResponse(responseBody)) {
        setError(errorMessageForStatus(res.status, responseBody));
        return;
      }

      setSuccess("Saved.");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDone = () => {
    if (createdKey) {
      router.push(`/api-keys/${encodeURIComponent(createdKey.apiKey.id)}`);
      router.refresh();
    }
  };

  const handleCopy = async () => {
    if (createdKey) {
      await navigator.clipboard.writeText(createdKey.rawKey);
      setSuccess("Copied to clipboard!");
    }
  };

  // Render the success panel if key was created
  if (createdKey) {
    return (
      <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl">
        <div className="space-y-2 border-b border-zinc-200 dark:border-zinc-800 pb-4">
          <h2 className="text-lg font-semibold text-green-700 dark:text-green-400">
            API KEY CREATED
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Copy this key now. It will not be shown again.
          </p>
        </div>

        <div className="space-y-3">
          <label htmlFor="raw-key" className={labelClassName}>
            Raw key
          </label>
          <div className="flex items-center gap-2">
            <input
              id="raw-key"
              type="text"
              readOnly
              value={createdKey.rawKey}
              className={`${inputClassName} font-mono flex-1`}
            />
            <button
              type="button"
              onClick={handleCopy}
              className={secondaryButtonClassName}
            >
              Copy
            </button>
          </div>
        </div>

        <div className="flex gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <button type="button" onClick={handleDone} className={primaryButtonClassName}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      autoComplete="off"
      className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl"
    >
      {error && <FormError error={error} />}
      {success && <FormAlert tone="success">{success}</FormAlert>}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-name" className={labelClassName}>
          Name <span className="text-red-500">*</span>
        </label>
        <input
          id="api-key-name"
          name="name"
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-description" className={labelClassName}>
          Description
        </label>
        <textarea
          id="api-key-description"
          name="description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-expires-at" className={labelClassName}>
          Expiration (optional)
        </label>
        <input
          id="api-key-expires-at"
          name="expiresAt"
          type="datetime-local"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Leave empty for no expiration. Must be a future date.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-allowed-models" className={labelClassName}>
          Allowed models (one per line or comma-separated)
        </label>
        <textarea
          id="api-key-allowed-models"
          name="allowedModels"
          rows={4}
          value={stringArrayToText(allowedModels)}
          onChange={handleAllowedModelsChange}
          disabled={isSubmitting}
          className={`${inputClassName} font-mono`}
          spellCheck={false}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Empty = all models allowed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-blocked-models" className={labelClassName}>
          Blocked models (one per line or comma-separated)
        </label>
        <textarea
          id="api-key-blocked-models"
          name="blockedModels"
          rows={4}
          value={stringArrayToText(blockedModels)}
          onChange={handleBlockedModelsChange}
          disabled={isSubmitting}
          className={`${inputClassName} font-mono`}
          spellCheck={false}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Empty = no models blocked.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={labelClassName}>Allowed endpoints</label>
        <div className="flex flex-wrap gap-3">
          {ALLOWED_ENDPOINTS.map((endpoint: AllowedEndpoint) => (
            <label
              key={endpoint}
              className="flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={allowedEndpoints.includes(endpoint)}
                onChange={(event) =>
                  handleEndpointChange(endpoint, event.target.checked)
                }
                disabled={isSubmitting}
                className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
              />
              <code className="text-xs font-mono">{ENDPOINT_LABELS[endpoint]}</code>
            </label>
          ))}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          All checked = all endpoints allowed. Uncheck to restrict. A key that
          includes embedContent can also call batchEmbedContents.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-requests-per-minute" className={labelClassName}>
            Requests per minute
          </label>
          <input
            id="api-key-requests-per-minute"
            name="requestsPerMinute"
            type="number"
            min={1}
            inputMode="numeric"
            value={requestsPerMinute}
            onChange={(event) =>
              setRequestsPerMinute(event.target.value || "")
            }
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Empty = no limit.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-requests-per-day" className={labelClassName}>
            Requests per day
          </label>
          <input
            id="api-key-requests-per-day"
            name="requestsPerDay"
            type="number"
            min={1}
            inputMode="numeric"
            value={requestsPerDay}
            onChange={(event) => setRequestsPerDay(event.target.value || "")}
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Empty = no limit.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-tokens-per-minute" className={labelClassName}>
            Tokens per minute
          </label>
          <input
            id="api-key-tokens-per-minute"
            name="tokensPerMinute"
            type="number"
            min={1}
            inputMode="numeric"
            value={tokensPerMinute}
            onChange={(event) => setTokensPerMinute(event.target.value || "")}
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Empty = no limit.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-tokens-per-day" className={labelClassName}>
            Tokens per day
          </label>
          <input
            id="api-key-tokens-per-day"
            name="tokensPerDay"
            type="number"
            min={1}
            inputMode="numeric"
            value={tokensPerDay}
            onChange={(event) => setTokensPerDay(event.target.value || "")}
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Empty = no limit.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-tokens-per-month" className={labelClassName}>
            Tokens per month
          </label>
          <input
            id="api-key-tokens-per-month"
            name="tokensPerMonth"
            type="number"
            min={1}
            inputMode="numeric"
            value={tokensPerMonth}
            onChange={(event) => setTokensPerMonth(event.target.value || "")}
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Empty = no limit.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-max-concurrent-requests" className={labelClassName}>
          Max concurrent requests
        </label>
        <input
          id="api-key-max-concurrent-requests"
          name="maxConcurrentRequests"
          type="number"
          min={1}
          inputMode="numeric"
          value={maxConcurrentRequests}
          onChange={(event) =>
            setMaxConcurrentRequests(event.target.value || "")
          }
          disabled={isSubmitting}
          className={inputClassName}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Empty = no limit.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-allowed-ips" className={labelClassName}>
          Allowed IPs / CIDRs (one per line)
        </label>
        <textarea
          id="api-key-allowed-ips"
          name="allowedIPs"
          rows={4}
          value={allowedIPs.join("\n")}
          onChange={handleAllowedIPsChange}
          disabled={isSubmitting}
          className={`${inputClassName} font-mono`}
          spellCheck={false}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Empty = all IPs allowed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-blocked-ips" className={labelClassName}>
          Blocked IPs / CIDRs (one per line)
        </label>
        <textarea
          id="api-key-blocked-ips"
          name="blockedIPs"
          rows={4}
          value={blockedIPs.join("\n")}
          onChange={handleBlockedIPsChange}
          disabled={isSubmitting}
          className={`${inputClassName} font-mono`}
          spellCheck={false}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Empty = no IPs blocked.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api-key-tags" className={labelClassName}>
          Tags (comma-separated)
        </label>
        <input
          id="api-key-tags"
          name="tags"
          type="text"
          value={stringArrayToText(tags)}
          onChange={handleTagsChange}
          disabled={isSubmitting}
          className={inputClassName}
        />
      </div>

      <div>
        <button type="submit" disabled={isSubmitting} className={primaryButtonClassName}>
          {isSubmitting
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
            ? "Create API key"
            : "Save changes"}
        </button>
      </div>
    </form>
  );
}