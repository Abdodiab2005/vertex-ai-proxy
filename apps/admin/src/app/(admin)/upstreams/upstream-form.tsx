"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  AUTH_METHOD_LABELS,
  LOCATION_SUGGESTIONS,
  isRecord,
  isUpstreamAuthMethod,
  isUpstreamResponse,
  type CreateUpstreamRequest,
  type PatchUpstreamRequest,
  type UpstreamAuthMethod,
  type UpstreamView,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { FormAlert, FormError } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const primaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

type UpstreamFormProps =
  | { mode: "create" }
  | { mode: "edit"; upstream: UpstreamView };

function parseServiceAccountJson(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "Service account key is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Service account key must be a JSON object." };
  }
  return { ok: true, value: parsed };
}

export function UpstreamForm(props: UpstreamFormProps) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initial = props.mode === "edit" ? props.upstream : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [authMethod, setAuthMethod] = useState<UpstreamAuthMethod>(
    initial?.authMethod ?? "application-default-credentials",
  );
  const [priority, setPriority] = useState(initial?.priority ?? 0);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const originalAuthMethod = initial?.authMethod ?? null;
  const authMethodUnchanged = originalAuthMethod === authMethod;
  const credentialsRequired =
    (authMethod === "service-account" || authMethod === "api-key") &&
    (props.mode === "create" || !authMethodUnchanged);

  const clearCredentialInputs = () => {
    setServiceAccountJson("");
    setApiKey("");
    setCredentialError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAuthMethodChange = (next: UpstreamAuthMethod) => {
    setAuthMethod(next);
    clearCredentialInputs();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      setServiceAccountJson(text);
      setCredentialError(null);
    } catch {
      setCredentialError("Could not read that file.");
    }
  };

  const buildCredentials = ():
    | { ok: true; credentials?: Record<string, unknown> | string }
    | { ok: false } => {
    if (authMethod === "application-default-credentials") {
      return { ok: true };
    }

    if (authMethod === "service-account") {
      const trimmed = serviceAccountJson.trim();
      if (!trimmed) {
        if (credentialsRequired) {
          setCredentialError("A service account key is required.");
          return { ok: false };
        }
        return { ok: true };
      }
      const parsed = parseServiceAccountJson(trimmed);
      if (!parsed.ok) {
        setCredentialError(parsed.error);
        return { ok: false };
      }
      return { ok: true, credentials: parsed.value };
    }

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      if (credentialsRequired) {
        setCredentialError("An API key is required.");
        return { ok: false };
      }
      return { ok: true };
    }
    return { ok: true, credentials: trimmedKey };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setCredentialError(null);

    const credentialsResult = buildCredentials();
    if (!credentialsResult.ok) {
      return;
    }

    setIsSubmitting(true);

    try {
      if (props.mode === "create") {
        const body: CreateUpstreamRequest = {
          name: name.trim(),
          projectId: projectId.trim(),
          location: location.trim(),
          authMethod,
          enabled,
          priority,
        };
        if (credentialsResult.credentials !== undefined) {
          body.credentials = credentialsResult.credentials;
        }

        const res = await fetchAdminApi("/upstreams", {
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

        if (res.status !== 201 || !isUpstreamResponse(responseBody)) {
          setError(errorMessageForStatus(res.status, responseBody));
          return;
        }

        clearCredentialInputs();
        router.push(`/upstreams/${encodeURIComponent(responseBody.upstream.id)}`);
        router.refresh();
        return;
      }

      const { upstream } = props;
      const body: PatchUpstreamRequest = {};
      if (name.trim() !== upstream.name) {
        body.name = name.trim();
      }
      if (projectId.trim() !== upstream.projectId) {
        body.projectId = projectId.trim();
      }
      if (location.trim() !== upstream.location) {
        body.location = location.trim();
      }
      if (authMethod !== upstream.authMethod) {
        body.authMethod = authMethod;
      }
      if (enabled !== upstream.enabled) {
        body.enabled = enabled;
      }
      if (priority !== upstream.priority) {
        body.priority = priority;
      }
      if (credentialsResult.credentials !== undefined) {
        body.credentials = credentialsResult.credentials;
      }

      if (Object.keys(body).length === 0) {
        setSuccess("No changes to save.");
        return;
      }

      const res = await fetchAdminApi(`/upstreams/${encodeURIComponent(upstream.id)}`, {
        method: "PATCH",
        csrfToken,
        body,
      });
      const responseBody = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 200 || !isUpstreamResponse(responseBody)) {
        setError(errorMessageForStatus(res.status, responseBody));
        return;
      }

      clearCredentialInputs();
      setSuccess("Saved.");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      autoComplete="off"
      className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl"
    >
      {error && <FormError error={error} />}
      {success && <FormAlert tone="success">{success}</FormAlert>}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="upstream-name" className={labelClassName}>
          Name
        </label>
        <input
          id="upstream-name"
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
        <label htmlFor="upstream-project-id" className={labelClassName}>
          Project ID
        </label>
        <input
          id="upstream-project-id"
          name="projectId"
          type="text"
          required
          maxLength={30}
          dir="ltr"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="upstream-location" className={labelClassName}>
          Location
        </label>
        <input
          id="upstream-location"
          name="location"
          type="text"
          required
          maxLength={50}
          list="upstream-location-options"
          dir="ltr"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        />
        <datalist id="upstream-location-options">
          {LOCATION_SUGGESTIONS.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="upstream-auth-method" className={labelClassName}>
          Authentication method
        </label>
        <select
          id="upstream-auth-method"
          name="authMethod"
          value={authMethod}
          onChange={(event) => {
            if (isUpstreamAuthMethod(event.target.value)) {
              handleAuthMethodChange(event.target.value);
            }
          }}
          disabled={isSubmitting}
          className={inputClassName}
        >
          {Object.entries(AUTH_METHOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {authMethod === "application-default-credentials" && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The API server&apos;s own Google credentials (application default credentials) are used.
        </p>
      )}

      {authMethod === "service-account" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="upstream-sa-json" className={labelClassName}>
            Service account key JSON
            {credentialsRequired ? "" : " (leave empty to keep stored credentials)"}
          </label>
          {props.mode === "edit" && authMethodUnchanged && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {props.upstream.credentialSummary
                ? `Stored: ${props.upstream.credentialSummary}`
                : props.upstream.hasCredentials
                  ? "Credentials stored"
                  : "No credentials stored"}
            </p>
          )}
          <textarea
            id="upstream-sa-json"
            name="serviceAccountJson"
            rows={8}
            required={credentialsRequired}
            spellCheck={false}
            autoComplete="off"
            value={serviceAccountJson}
            onChange={(event) => {
              setServiceAccountJson(event.target.value);
              setCredentialError(null);
            }}
            disabled={isSubmitting}
            aria-invalid={credentialError ? true : undefined}
            aria-describedby={credentialError ? "upstream-credential-error" : undefined}
            className={`${inputClassName} font-mono`}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="upstream-sa-file" className="text-sm text-zinc-600 dark:text-zinc-400">
              Or load a .json key file
            </label>
            <input
              id="upstream-sa-file"
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              disabled={isSubmitting}
              className="text-sm text-zinc-700 dark:text-zinc-300 file:me-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-zinc-100 file:text-zinc-800 dark:file:bg-zinc-800 dark:file:text-zinc-200"
            />
          </div>
        </div>
      )}

      {authMethod === "api-key" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="upstream-api-key" className={labelClassName}>
            API key
            {credentialsRequired ? "" : " (leave empty to keep stored credentials)"}
          </label>
          {props.mode === "edit" && authMethodUnchanged && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {props.upstream.credentialSummary
                ? `Stored: ${props.upstream.credentialSummary}`
                : props.upstream.hasCredentials
                  ? "Credentials stored"
                  : "No credentials stored"}
            </p>
          )}
          <input
            id="upstream-api-key"
            name="apiKey"
            type="password"
            required={credentialsRequired}
            autoComplete="off"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setCredentialError(null);
            }}
            disabled={isSubmitting}
            aria-invalid={credentialError ? true : undefined}
            aria-describedby={credentialError ? "upstream-credential-error" : undefined}
            className={inputClassName}
          />
        </div>
      )}

      {credentialError && (
        <p id="upstream-credential-error" className="text-sm text-red-600 dark:text-red-400">
          {credentialError}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="upstream-priority" className={labelClassName}>
          Priority
        </label>
        <input
          id="upstream-priority"
          name="priority"
          type="number"
          min={0}
          max={1000}
          step={1}
          required
          inputMode="numeric"
          value={priority}
          onChange={(event) => setPriority(Number.parseInt(event.target.value, 10) || 0)}
          disabled={isSubmitting}
          className={inputClassName}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Lower numbers are preferred. 0–1000.</p>
      </div>

      <label className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
        <input
          type="checkbox"
          name="enabled"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          disabled={isSubmitting}
          className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        />
        Enabled
      </label>

      <div>
        <button type="submit" disabled={isSubmitting} className={primaryButtonClassName}>
          {isSubmitting
            ? props.mode === "create"
              ? "Creating..."
              : "Saving..."
            : props.mode === "create"
              ? "Create upstream"
              : "Save changes"}
        </button>
      </div>
    </form>
  );
}
