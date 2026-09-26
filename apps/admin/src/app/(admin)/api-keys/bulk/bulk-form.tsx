"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../../lib/admin-api";
import {
  ALLOWED_ENDPOINTS,
  ENDPOINT_LABELS,
  isBulkCreateApiKeysResponse,
  type AllowedEndpoint,
  type BulkCreateApiKeysRequest,
  type BulkCreatedKey,
  type BulkTesterInput,
  type KeyPresetView,
  type KeyPresetWriteRequest,
} from "../../../../lib/types";
import { useAdminSession } from "../../admin-session";
import { FormError } from "../../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const hintClassName = "text-xs text-zinc-500 dark:text-zinc-400";

const primaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const secondaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

type LimitKey =
  | "requestsPerMinute"
  | "requestsPerDay"
  | "tokensPerMinute"
  | "tokensPerDay"
  | "tokensPerMonth"
  | "maxConcurrentRequests";

const LIMIT_FIELDS: ReadonlyArray<{ key: LimitKey; label: string }> = [
  { key: "requestsPerMinute", label: "Requests per minute" },
  { key: "requestsPerDay", label: "Requests per day" },
  { key: "tokensPerMinute", label: "Tokens per minute" },
  { key: "tokensPerDay", label: "Tokens per day" },
  { key: "tokensPerMonth", label: "Tokens per month" },
  { key: "maxConcurrentRequests", label: "Max concurrent requests" },
];

type GeneratedBatch = {
  keys: BulkCreatedKey[];
  csv: string;
  filename: string;
};

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

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char ?? "";
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char ?? "";
    }
  }
  fields.push(current);
  return fields;
}

function parseTesters(text: string): { testers?: BulkTesterInput[]; error?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return {};
  }

  const testers: BulkTesterInput[] = [];
  for (const [index, line] of lines.entries()) {
    const fields = parseCsvLine(line);
    if (fields.length > 4) {
      return { error: `Tester line ${index + 1} has more than 4 fields.` };
    }
    const [testerName, email, googlePlayTesterNumber, notes] = fields;
    const tester: BulkTesterInput = {};
    if (testerName !== undefined && testerName.trim() !== "") {
      tester.testerName = testerName.trim();
    }
    if (email !== undefined && email.trim() !== "") {
      tester.email = email.trim();
    }
    if (googlePlayTesterNumber !== undefined && googlePlayTesterNumber.trim() !== "") {
      tester.googlePlayTesterNumber = googlePlayTesterNumber.trim();
    }
    if (notes !== undefined && notes.trim() !== "") {
      tester.notes = notes.trim();
    }
    testers.push(tester);
  }
  return { testers };
}

function csvFilename(prefix: string): string {
  const safe = prefix.replace(/[^\w.-]+/g, "_");
  return `${safe.length > 0 ? safe : "api-keys"}-keys.csv`;
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function creditLabel(entry: BulkCreatedKey): string {
  const remaining = entry.apiKey.credit?.remaining;
  if (remaining === undefined || remaining === "0") {
    return "—";
  }
  return remaining;
}

function expiryLabel(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
}

export function BulkKeyForm({ presets }: { presets: KeyPresetView[] }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();

  const [presetId, setPresetId] = useState("");
  const [namePrefix, setNamePrefix] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [testersText, setTestersText] = useState("");
  const [description, setDescription] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [blockedModels, setBlockedModels] = useState("");
  const [tags, setTags] = useState("");
  const [initialCredit, setInitialCredit] = useState("");
  const [lifetimeDays, setLifetimeDays] = useState("");
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    requestsPerMinute: "",
    requestsPerDay: "",
    tokensPerMinute: "",
    tokensPerDay: "",
    tokensPerMonth: "",
    maxConcurrentRequests: "",
  });
  const [overrideEndpoints, setOverrideEndpoints] = useState(false);
  const [endpoints, setEndpoints] = useState<AllowedEndpoint[]>([...ALLOWED_ENDPOINTS]);
  const [error, setError] = useState<string | string[] | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [batch, setBatch] = useState<GeneratedBatch | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const prefix = namePrefix.trim();
    if (prefix.length === 0 || prefix.length > 80) {
      setError("Name prefix must be 1 to 80 characters.");
      return;
    }
    if (!/^[1-9]\d*$/.test(quantity.trim())) {
      setError("Quantity must be a whole number from 1 to 200.");
      return;
    }
    const quantityNumber = Number(quantity.trim());
    if (quantityNumber > 200) {
      setError("Quantity must be a whole number from 1 to 200.");
      return;
    }

    const parsedTesters = parseTesters(testersText);
    if (parsedTesters.error !== undefined) {
      setError(parsedTesters.error);
      return;
    }
    if (
      parsedTesters.testers !== undefined &&
      parsedTesters.testers.length !== quantityNumber
    ) {
      setError(
        `Enter ${quantityNumber} tester lines, or leave the tester list empty. Found ${parsedTesters.testers.length}.`,
      );
      return;
    }

    const overrides: Omit<KeyPresetWriteRequest, "name"> = {};
    if (description.trim() !== "") {
      overrides.description = description.trim();
    }
    const allowed = parseStringArray(allowedModels);
    if (allowed.length > 0) {
      overrides.allowedModels = allowed;
    }
    const blocked = parseStringArray(blockedModels);
    if (blocked.length > 0) {
      overrides.blockedModels = blocked;
    }
    const tagList = parseStringArray(tags);
    if (tagList.length > 0) {
      overrides.tags = tagList;
    }
    if (initialCredit.trim() !== "") {
      overrides.initialCredit = initialCredit.trim();
    }

    const lifetime = parsePositiveInt(lifetimeDays, "Lifetime");
    if (!lifetime.ok) {
      setError(lifetime.error);
      return;
    }
    if (lifetime.value !== null) {
      if (lifetime.value > 3650) {
        setError("Lifetime must be 3650 days or less.");
        return;
      }
      overrides.lifetimeDays = lifetime.value;
    }

    for (const field of LIMIT_FIELDS) {
      const parsed = parsePositiveInt(limits[field.key], field.label);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      if (parsed.value !== null) {
        overrides[field.key] = parsed.value;
      }
    }

    if (overrideEndpoints) {
      overrides.allowedEndpoints =
        endpoints.length > 0 && endpoints.length < ALLOWED_ENDPOINTS.length ? endpoints : [];
    }

    const body: BulkCreateApiKeysRequest = {
      namePrefix: prefix,
      quantity: quantityNumber,
    };
    if (presetId !== "") {
      body.presetId = presetId;
    }
    if (Object.keys(overrides).length > 0) {
      body.overrides = overrides;
    }
    if (parsedTesters.testers !== undefined) {
      body.testers = parsedTesters.testers;
    }

    setIsSubmitting(true);
    try {
      const res = await fetchAdminApi("/api-keys/bulk", {
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
      if (res.status !== 201 || !isBulkCreateApiKeysResponse(responseBody)) {
        setError(errorMessageForStatus(res.status, responseBody));
        return;
      }
      setBatch({
        keys: responseBody.keys,
        csv: responseBody.csv,
        filename: csvFilename(prefix),
      });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (batch !== null) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md dark:text-amber-200 dark:bg-amber-950 dark:border-amber-900"
        >
          Copy these keys now. They will not be shown again, and this page does not save them.
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => downloadCsv(batch.csv, batch.filename)}
            className={primaryButtonClassName}
          >
            Download CSV
          </button>
          <button
            type="button"
            onClick={() => setBatch(null)}
            className={secondaryButtonClassName}
          >
            Generate another batch
          </button>
        </div>
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Credit</th>
                <th className="px-4 py-3 font-medium">Expires</th>
              </tr>
            </thead>
            <tbody>
              {batch.keys.map((entry) => (
                <tr
                  key={entry.apiKey.id}
                  className="border-b border-zinc-200 dark:border-zinc-800 last:border-0"
                >
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-100">
                    {entry.apiKey.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs break-all text-zinc-800 dark:text-zinc-200 min-w-0">
                    {entry.rawKey}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {creditLabel(entry)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {expiryLabel(entry.apiKey.expiresAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <div className="flex flex-col gap-1.5">
        <label htmlFor="bulk-preset" className={labelClassName}>
          Preset
        </label>
        <select
          id="bulk-preset"
          name="presetId"
          value={presetId}
          onChange={(event) => setPresetId(event.target.value)}
          disabled={isSubmitting}
          className={inputClassName}
        >
          <option value="">No preset (use settings defaults)</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bulk-prefix" className={labelClassName}>
            Name prefix <span className="text-red-500">*</span>
          </label>
          <input
            id="bulk-prefix"
            name="namePrefix"
            type="text"
            required
            maxLength={80}
            value={namePrefix}
            onChange={(event) => setNamePrefix(event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
            placeholder="play"
          />
          <p className={hintClassName}>Keys are named “prefix 01”, “prefix 02”, and so on.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bulk-quantity" className={labelClassName}>
            Quantity <span className="text-red-500">*</span>
          </label>
          <input
            id="bulk-quantity"
            name="quantity"
            type="number"
            required
            min={1}
            max={200}
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>
      </div>

      <details className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Overrides
        </summary>
        <p className={hintClassName}>
          Filled fields replace the preset and the settings default. Leave a field empty to keep
          the value those would produce.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="override-description" className={labelClassName}>
            Description
          </label>
          <input
            id="override-description"
            name="description"
            type="text"
            maxLength={1000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="override-allowed-models" className={labelClassName}>
            Allowed models
          </label>
          <textarea
            id="override-allowed-models"
            name="allowedModels"
            rows={3}
            value={allowedModels}
            onChange={(event) => setAllowedModels(event.target.value)}
            disabled={isSubmitting}
            className={`${inputClassName} font-mono`}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="override-blocked-models" className={labelClassName}>
            Blocked models
          </label>
          <textarea
            id="override-blocked-models"
            name="blockedModels"
            rows={3}
            value={blockedModels}
            onChange={(event) => setBlockedModels(event.target.value)}
            disabled={isSubmitting}
            className={`${inputClassName} font-mono`}
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {LIMIT_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={`override-${field.key}`} className={labelClassName}>
                {field.label}
              </label>
              <input
                id={`override-${field.key}`}
                name={field.key}
                type="number"
                min={1}
                inputMode="numeric"
                value={limits[field.key]}
                onChange={(event) =>
                  setLimits((current) => ({ ...current, [field.key]: event.target.value }))
                }
                disabled={isSubmitting}
                className={inputClassName}
              />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="override-credit" className={labelClassName}>
              Initial credit
            </label>
            <input
              id="override-credit"
              name="initialCredit"
              type="text"
              inputMode="decimal"
              value={initialCredit}
              onChange={(event) => setInitialCredit(event.target.value)}
              disabled={isSubmitting}
              className={inputClassName}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="override-lifetime" className={labelClassName}>
              Lifetime (days)
            </label>
            <input
              id="override-lifetime"
              name="lifetimeDays"
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={lifetimeDays}
              onChange={(event) => setLifetimeDays(event.target.value)}
              disabled={isSubmitting}
              className={inputClassName}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="override-tags" className={labelClassName}>
            Tags
          </label>
          <input
            id="override-tags"
            name="tags"
            type="text"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>
        <fieldset className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input
              type="checkbox"
              checked={overrideEndpoints}
              onChange={(event) => setOverrideEndpoints(event.target.checked)}
              disabled={isSubmitting}
              className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
            />
            Override allowed endpoints
          </label>
          {overrideEndpoints && (
            <div className="flex flex-wrap gap-3">
              {ALLOWED_ENDPOINTS.map((endpoint) => (
                <label
                  key={endpoint}
                  className="flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100"
                >
                  <input
                    type="checkbox"
                    checked={endpoints.includes(endpoint)}
                    onChange={(event) => {
                      setEndpoints((current) =>
                        event.target.checked
                          ? [...current, endpoint]
                          : current.filter((item) => item !== endpoint),
                      );
                    }}
                    disabled={isSubmitting}
                    className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
                  />
                  <code className="text-xs font-mono">{ENDPOINT_LABELS[endpoint]}</code>
                </label>
              ))}
            </div>
          )}
          <p className={hintClassName}>
            A key that includes embedContent can also call batchEmbedContents.
          </p>
        </fieldset>
      </details>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="bulk-testers" className={labelClassName}>
          Testers
        </label>
        <textarea
          id="bulk-testers"
          name="testers"
          rows={6}
          value={testersText}
          onChange={(event) => setTestersText(event.target.value)}
          disabled={isSubmitting}
          className={`${inputClassName} font-mono`}
          spellCheck={false}
          placeholder={"Ada,ada@example.com,1,Pixel 8\nBea,bea@example.com,2,"}
        />
        <p className={hintClassName}>
          Optional. One CSV line per tester: testerName, email, googlePlayTesterNumber, notes.
          When filled in, the number of lines must match the quantity. Line 1 is stored on key 01.
        </p>
      </div>

      <button type="submit" disabled={isSubmitting} className={primaryButtonClassName}>
        {isSubmitting ? "Generating..." : "Generate keys"}
      </button>
    </form>
  );
}
