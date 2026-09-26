"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../../lib/admin-api";
import {
  ALLOWED_ENDPOINTS,
  ENDPOINT_LABELS,
  isAllowedEndpoint,
  isKeyPresetResponse,
  type AllowedEndpoint,
  type KeyPresetView,
  type KeyPresetWriteRequest,
} from "../../../../lib/types";
import { useAdminSession } from "../../admin-session";
import { FormAlert, FormError } from "../../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const hintClassName = "text-xs text-zinc-500 dark:text-zinc-400";

const primaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const secondaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const dangerButtonClassName =
  "px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 disabled:opacity-50";

type LimitKey =
  | "requestsPerMinute"
  | "requestsPerDay"
  | "tokensPerMinute"
  | "tokensPerDay"
  | "tokensPerMonth"
  | "maxConcurrentRequests";

type PresetFormState = {
  name: string;
  description: string;
  allowedModels: string;
  blockedModels: string;
  allowedEndpoints: AllowedEndpoint[];
  requestsPerMinute: string;
  requestsPerDay: string;
  tokensPerMinute: string;
  tokensPerDay: string;
  tokensPerMonth: string;
  maxConcurrentRequests: string;
  initialCredit: string;
  lifetimeDays: string;
  tags: string;
};

const LIMIT_FIELDS: ReadonlyArray<{ key: LimitKey; label: string }> = [
  { key: "requestsPerMinute", label: "Requests per minute" },
  { key: "requestsPerDay", label: "Requests per day" },
  { key: "tokensPerMinute", label: "Tokens per minute" },
  { key: "tokensPerDay", label: "Tokens per day" },
  { key: "tokensPerMonth", label: "Tokens per month" },
  { key: "maxConcurrentRequests", label: "Max concurrent requests" },
];

function emptyForm(): PresetFormState {
  return {
    name: "",
    description: "",
    allowedModels: "",
    blockedModels: "",
    allowedEndpoints: [...ALLOWED_ENDPOINTS],
    requestsPerMinute: "",
    requestsPerDay: "",
    tokensPerMinute: "",
    tokensPerDay: "",
    tokensPerMonth: "",
    maxConcurrentRequests: "",
    initialCredit: "",
    lifetimeDays: "",
    tags: "",
  };
}

function formFromPreset(preset: KeyPresetView): PresetFormState {
  const endpoints = preset.allowedEndpoints.filter(isAllowedEndpoint);
  return {
    name: preset.name,
    description: preset.description ?? "",
    allowedModels: preset.allowedModels.join("\n"),
    blockedModels: preset.blockedModels.join("\n"),
    allowedEndpoints: endpoints.length === 0 ? [...ALLOWED_ENDPOINTS] : endpoints,
    requestsPerMinute: preset.requestsPerMinute === null ? "" : String(preset.requestsPerMinute),
    requestsPerDay: preset.requestsPerDay === null ? "" : String(preset.requestsPerDay),
    tokensPerMinute: preset.tokensPerMinute === null ? "" : String(preset.tokensPerMinute),
    tokensPerDay: preset.tokensPerDay === null ? "" : String(preset.tokensPerDay),
    tokensPerMonth: preset.tokensPerMonth === null ? "" : String(preset.tokensPerMonth),
    maxConcurrentRequests:
      preset.maxConcurrentRequests === null ? "" : String(preset.maxConcurrentRequests),
    initialCredit: preset.initialCredit ?? "",
    lifetimeDays: preset.lifetimeDays === null ? "" : String(preset.lifetimeDays),
    tags: preset.tags.join(", "),
  };
}

function parseStringArray(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(
  value: string,
  label: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return { ok: false, error: `${label} must be a positive whole number.` };
  }
  return { ok: true, value: Number(trimmed) };
}

function messageFor(status: number, body: unknown): string | string[] {
  if (status === 409) {
    const parsed = errorMessageForStatus(400, body);
    if (typeof parsed === "string" && parsed !== "Please check the form and try again.") {
      return parsed;
    }
    return "A preset with this name already exists.";
  }
  return errorMessageForStatus(status, body);
}

export function PresetsPanel({ presets }: { presets: KeyPresetView[] }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const formRef = useRef<HTMLFormElement>(null);

  const [form, setForm] = useState<PresetFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField<K extends keyof PresetFormState>(key: K, value: PresetFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(preset: KeyPresetView) {
    setEditingId(preset.id);
    setForm(formFromPreset(preset));
    setError(null);
    setSuccess(null);
    setConfirmingDelete(null);
    formRef.current?.scrollIntoView({ block: "start" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    setSuccess(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const name = form.name.trim();
    if (name.length === 0) {
      setError("Name is required.");
      return;
    }

    const limits: Partial<Record<LimitKey, number | null>> = {};
    for (const field of LIMIT_FIELDS) {
      const parsed = parsePositiveInt(form[field.key], field.label);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      limits[field.key] = parsed.value;
    }

    const lifetime = parsePositiveInt(form.lifetimeDays, "Lifetime");
    if (!lifetime.ok) {
      setError(lifetime.error);
      return;
    }
    if (lifetime.value !== null && lifetime.value > 3650) {
      setError("Lifetime must be 3650 days or less.");
      return;
    }

    const endpoints =
      form.allowedEndpoints.length > 0 && form.allowedEndpoints.length < ALLOWED_ENDPOINTS.length
        ? form.allowedEndpoints
        : [];

    const body: KeyPresetWriteRequest = {
      name,
      description: form.description.trim() === "" ? null : form.description.trim(),
      allowedModels: parseStringArray(form.allowedModels),
      blockedModels: parseStringArray(form.blockedModels),
      allowedEndpoints: endpoints,
      requestsPerMinute: limits.requestsPerMinute,
      requestsPerDay: limits.requestsPerDay,
      tokensPerMinute: limits.tokensPerMinute,
      tokensPerDay: limits.tokensPerDay,
      tokensPerMonth: limits.tokensPerMonth,
      maxConcurrentRequests: limits.maxConcurrentRequests,
      initialCredit: form.initialCredit.trim() === "" ? null : form.initialCredit.trim(),
      lifetimeDays: lifetime.value,
      tags: parseStringArray(form.tags),
    };

    setIsSubmitting(true);
    try {
      const res =
        editingId === null
          ? await fetchAdminApi("/key-presets", { method: "POST", csrfToken, body })
          : await fetchAdminApi(`/key-presets/${encodeURIComponent(editingId)}`, {
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

      const ok = editingId === null ? res.status === 201 : res.status === 200;
      if (!ok || !isKeyPresetResponse(responseBody)) {
        setError(messageFor(res.status, responseBody));
        return;
      }

      setSuccess(editingId === null ? "Preset created." : "Saved.");
      setEditingId(null);
      setForm(emptyForm());
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(preset: KeyPresetView) {
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);
    try {
      const res = await fetchAdminApi(`/key-presets/${encodeURIComponent(preset.id)}`, {
        method: "DELETE",
        csrfToken,
      });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (res.status !== 204) {
        setError(messageFor(res.status, await readResponseBody(res)));
        return;
      }
      if (editingId === preset.id) {
        setEditingId(null);
        setForm(emptyForm());
      }
      setConfirmingDelete(null);
      setSuccess(`Deleted ${preset.name}.`);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        autoComplete="off"
        className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-4 max-w-2xl"
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {editingId === null ? "New preset" : "Edit preset"}
        </h2>
        {error && <FormError error={error} />}
        {success && <FormAlert tone="success">{success}</FormAlert>}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="preset-name" className={labelClassName}>
            Name <span className="text-red-500">*</span>
          </label>
          <input
            id="preset-name"
            name="name"
            type="text"
            required
            maxLength={100}
            value={form.name}
            onChange={(event) => updateField("name", event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="preset-description" className={labelClassName}>
            Description
          </label>
          <textarea
            id="preset-description"
            name="description"
            rows={2}
            maxLength={1000}
            value={form.description}
            onChange={(event) => updateField("description", event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="preset-allowed-models" className={labelClassName}>
            Allowed models
          </label>
          <textarea
            id="preset-allowed-models"
            name="allowedModels"
            rows={3}
            value={form.allowedModels}
            onChange={(event) => updateField("allowedModels", event.target.value)}
            disabled={isSubmitting}
            className={`${inputClassName} font-mono`}
            spellCheck={false}
          />
          <p className={hintClassName}>One per line or comma-separated. Empty allows every model.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="preset-blocked-models" className={labelClassName}>
            Blocked models
          </label>
          <textarea
            id="preset-blocked-models"
            name="blockedModels"
            rows={3}
            value={form.blockedModels}
            onChange={(event) => updateField("blockedModels", event.target.value)}
            disabled={isSubmitting}
            className={`${inputClassName} font-mono`}
            spellCheck={false}
          />
          <p className={hintClassName}>Empty blocks nothing.</p>
        </div>

        <fieldset className="space-y-2">
          <legend className={labelClassName}>Allowed endpoints</legend>
          <div className="flex flex-wrap gap-3">
            {ALLOWED_ENDPOINTS.map((endpoint) => (
              <label
                key={endpoint}
                className="flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100"
              >
                <input
                  type="checkbox"
                  checked={form.allowedEndpoints.includes(endpoint)}
                  onChange={(event) => {
                    updateField(
                      "allowedEndpoints",
                      event.target.checked
                        ? [...form.allowedEndpoints, endpoint]
                        : form.allowedEndpoints.filter((item) => item !== endpoint),
                    );
                  }}
                  disabled={isSubmitting}
                  className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
                />
                <code className="text-xs font-mono">{ENDPOINT_LABELS[endpoint]}</code>
              </label>
            ))}
          </div>
          <p className={hintClassName}>
            Every endpoint checked allows all of them. A key that includes embedContent can also
            call batchEmbedContents.
          </p>
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {LIMIT_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={`preset-${field.key}`} className={labelClassName}>
                {field.label}
              </label>
              <input
                id={`preset-${field.key}`}
                name={field.key}
                type="number"
                min={1}
                inputMode="numeric"
                value={form[field.key]}
                onChange={(event) => updateField(field.key, event.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
              />
            </div>
          ))}
        </div>
        <p className={hintClassName}>Empty rate limits mean no limit.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="preset-initial-credit" className={labelClassName}>
              Initial credit
            </label>
            <input
              id="preset-initial-credit"
              name="initialCredit"
              type="text"
              inputMode="decimal"
              value={form.initialCredit}
              onChange={(event) => updateField("initialCredit", event.target.value)}
              disabled={isSubmitting}
              className={inputClassName}
              placeholder="12.50"
            />
            <p className={hintClassName}>Empty grants no credit. Use a decimal such as 12.50.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="preset-lifetime" className={labelClassName}>
              Lifetime (days)
            </label>
            <input
              id="preset-lifetime"
              name="lifetimeDays"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={form.lifetimeDays}
              onChange={(event) => updateField("lifetimeDays", event.target.value)}
              disabled={isSubmitting}
              className={inputClassName}
            />
            <p className={hintClassName}>Empty means the key does not expire.</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="preset-tags" className={labelClassName}>
            Tags
          </label>
          <input
            id="preset-tags"
            name="tags"
            type="text"
            value={form.tags}
            onChange={(event) => updateField("tags", event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
          <p className={hintClassName}>Comma-separated.</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={isSubmitting} className={primaryButtonClassName}>
            {isSubmitting ? "Saving..." : editingId === null ? "Create preset" : "Save changes"}
          </button>
          {editingId !== null && (
            <button
              type="button"
              onClick={cancelEdit}
              disabled={isSubmitting}
              className={secondaryButtonClassName}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {presets.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center">
          <p className="text-zinc-600 dark:text-zinc-400">No presets yet. Create one above.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Credit</th>
                <th className="px-4 py-3 font-medium">Lifetime</th>
                <th className="px-4 py-3 font-medium">Req/min</th>
                <th className="px-4 py-3 font-medium">Models</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {presets.map((preset) => (
                <tr
                  key={preset.id}
                  className="border-b border-zinc-200 dark:border-zinc-800 last:border-0"
                >
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                    {preset.name}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                    {preset.initialCredit ?? "None"}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                    {preset.lifetimeDays === null ? "No expiry" : `${preset.lifetimeDays} days`}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                    {preset.requestsPerMinute === null ? "No limit" : String(preset.requestsPerMinute)}
                  </td>
                  <td
                    className="px-4 py-3 text-zinc-700 dark:text-zinc-300 max-w-xs truncate"
                    title={preset.allowedModels.join(", ")}
                  >
                    {preset.allowedModels.length === 0 ? "All models" : preset.allowedModels.join(", ")}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {confirmingDelete === preset.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-red-600 dark:text-red-400">
                          Delete {preset.name}? Existing keys are kept.
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDelete(preset)}
                          disabled={isSubmitting}
                          className={dangerButtonClassName}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          disabled={isSubmitting}
                          className="px-2 py-1 text-xs font-medium text-zinc-700 bg-zinc-200 rounded hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(preset)}
                          disabled={isSubmitting}
                          className="px-2 py-1 text-xs font-medium text-zinc-700 bg-zinc-100 rounded hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900 disabled:opacity-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(preset.id)}
                          disabled={isSubmitting}
                          className="px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 rounded dark:text-red-400 dark:hover:bg-red-950 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
