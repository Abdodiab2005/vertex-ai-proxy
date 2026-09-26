"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  isSettingsUpdateResponse,
  type SettingDefinition,
  type SettingValue,
  type SpendStatus,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { ErrorPanel } from "../error-panel";
import { FormAlert, FormError } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const descriptionClassName = "text-sm text-zinc-600 dark:text-zinc-400";

const primaryButtonClassName =
  "px-4 py-2 min-h-11 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const dangerButtonClassName =
  "px-4 py-2 min-h-11 text-sm font-medium text-white bg-red-700 rounded-md hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const secondaryButtonClassName =
  "px-4 py-2 min-h-11 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const SPEND_LABEL = "Gateway tracked / estimated upstream spend";

const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;

type EditorValue = string | boolean;

type Section = {
  id: string;
  title: string;
  description: string;
  keys: readonly string[];
  spendPanel?: boolean;
};

const SECTIONS: readonly Section[] = [
  {
    id: "gateway",
    title: "Gateway",
    description: "These apply to every public request.",
    keys: [
      "gateway.enabled",
      "gateway.maintenanceMode",
      "gateway.maintenanceMessage",
      "gateway.killSwitch",
    ],
  },
  {
    id: "keys",
    title: "Key defaults",
    description:
      "Used when creating an API key leaves a field out. A value sent with the key wins.",
    keys: [
      "keys.defaultRequestsPerMinute",
      "keys.defaultRequestsPerDay",
      "keys.defaultMaxConcurrentRequests",
      "keys.defaultInitialCredit",
      "keys.defaultAllowedModels",
      "keys.defaultLifetimeDays",
    ],
  },
  {
    id: "timeouts",
    title: "Timeouts",
    description: "Limits for public requests and upstream connections.",
    keys: ["timeouts.requestMs", "timeouts.streamIdleMs", "timeouts.upstreamConnectMs"],
  },
  {
    id: "media",
    title: "Media",
    description: "Inline images, audio, video and PDFs, and file URIs sent as fileData.",
    keys: ["media.maxInlineBytes", "media.allowFileUris", "media.fileUriHoldTokens"],
  },
  {
    id: "logging",
    title: "Logging",
    description: "How long metadata is kept, and whether request content is stored.",
    keys: ["logging.metadataRetentionDays", "logging.contentLoggingEnabled"],
  },
  {
    id: "billing",
    title: "Billing and URL",
    description: "Currency for prices, and the public address of this gateway.",
    keys: ["billing.currency", "gateway.publicUrl"],
  },
  {
    id: "spend",
    title: SPEND_LABEL,
    description:
      "Your estimate of remaining Google Cloud credit, and the point at which new AI requests stop. This is not the authoritative Google Cloud billing balance.",
    keys: ["spend.upstreamBudget", "spend.safetyReserve", "spend.blockWhenThresholdReached"],
    spendPanel: true,
  },
];

function fieldId(key: string): string {
  return `setting-${key.replaceAll(".", "-")}`;
}

function toEditorValue(definition: SettingDefinition, value: SettingValue): EditorValue {
  if (definition.type === "boolean") {
    return value === true;
  }
  if (definition.type === "string-list") {
    return Array.isArray(value) ? value.join("\n") : "";
  }
  if (value === null) {
    return "";
  }
  return String(value);
}

function initialEditor(
  settings: Record<string, SettingValue>,
  definitions: SettingDefinition[],
): Record<string, EditorValue> {
  const editor: Record<string, EditorValue> = {};
  for (const definition of definitions) {
    const value = settings[definition.key];
    editor[definition.key] = toEditorValue(
      definition,
      value === undefined ? definition.default : value,
    );
  }
  return editor;
}

function sameSettingValue(left: SettingValue, right: SettingValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

function parseEditorValue(
  definition: SettingDefinition,
  raw: EditorValue,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  if (definition.type === "boolean") {
    if (typeof raw !== "boolean") {
      return { ok: false, error: "Choose on or off." };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "Enter a text value." };
  }

  if (definition.type === "string-list") {
    const items = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, value: items };
  }

  const trimmed = definition.key === "billing.currency" ? raw.trim().toUpperCase() : raw.trim();
  if (trimmed.length === 0) {
    if (definition.nullable) {
      return { ok: true, value: null };
    }
    return { ok: false, error: "This field is required." };
  }

  if (definition.type === "integer") {
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, error: "Enter a whole number." };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: "Enter a whole number." };
    }
    return { ok: true, value: parsed };
  }

  if (definition.type === "decimal") {
    if (!DECIMAL_PATTERN.test(trimmed)) {
      return { ok: false, error: "Enter an amount like 20 or 20.5, with at most 6 decimal places." };
    }
    return { ok: true, value: trimmed };
  }

  if (definition.key === "gateway.maintenanceMessage" && trimmed.length > 300) {
    return { ok: false, error: "Use 300 characters or fewer." };
  }

  if (definition.key === "billing.currency" && !/^[A-Z]{3}$/.test(trimmed)) {
    return { ok: false, error: "Enter a three-letter currency code, such as USD." };
  }

  return { ok: true, value: trimmed };
}

function errorsByKey(
  message: string | string[],
  definitions: SettingDefinition[],
): { field: Record<string, string>; rest: string[] } {
  const lines = Array.isArray(message) ? message : [message];
  const known = new Set(definitions.map((definition) => definition.key));
  const field: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf(": ");
    const key = separator === -1 ? "" : line.slice(0, separator);
    if (separator > 0 && known.has(key)) {
      field[key] = line.slice(separator + 2);
    } else {
      rest.push(line);
    }
  }
  return { field, rest };
}

export function SettingsForm({
  settings,
  definitions,
  spend,
  spendError,
}: {
  settings: Record<string, SettingValue>;
  definitions: SettingDefinition[];
  spend: SpendStatus | null;
  spendError: string | null;
}) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const formErrorId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));

  const [baseline, setBaseline] = useState(settings);
  const [editor, setEditor] = useState(() => initialEditor(settings, definitions));
  const [killArmed, setKillArmed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!killArmed) {
      return;
    }
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setKillArmed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [killArmed]);

  const updateEditor = (key: string, value: EditorValue) => {
    setEditor((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (current[key] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSuccess(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSuccess(null);

    const nextFieldErrors: Record<string, string> = {};
    const partial: Record<string, SettingValue> = {};
    for (const definition of definitions) {
      const raw = editor[definition.key];
      if (raw === undefined) {
        continue;
      }
      const parsed = parseEditorValue(definition, raw);
      if (!parsed.ok) {
        nextFieldErrors[definition.key] = parsed.error;
        continue;
      }
      const stored = baseline[definition.key];
      const current = stored === undefined ? definition.default : stored;
      if (!sameSettingValue(parsed.value, current)) {
        partial[definition.key] = parsed.value;
      }
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setFormError("Some settings need attention.");
      return;
    }
    setFieldErrors({});

    if (Object.keys(partial).length === 0) {
      setSuccess("No changes to save.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetchAdminApi("/settings", {
        method: "PUT",
        csrfToken,
        body: partial,
      });
      const body = await readResponseBody(response);

      if (response.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (response.status === 400) {
        const message = errorMessageForStatus(response.status, body);
        const partitioned = errorsByKey(message, definitions);
        setFieldErrors(partitioned.field);
        setFormError(partitioned.rest.length > 0 ? partitioned.rest : message);
        return;
      }

      if (response.status !== 200 || !isSettingsUpdateResponse(body)) {
        setFormError(errorMessageForStatus(response.status, body));
        return;
      }

      setBaseline(body.settings);
      setEditor(initialEditor(body.settings, definitions));
      setKillArmed(false);
      setSuccess("Settings saved.");
      router.refresh();
    } catch {
      setFormError("Settings could not be saved. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" aria-busy={isSubmitting} className="space-y-6 min-w-0">
      <div aria-live="polite" className="space-y-3" id={formErrorId}>
        {formError ? <FormError error={formError} /> : null}
        {success ? <FormAlert tone="success">{success}</FormAlert> : null}
      </div>

      <fieldset disabled={isSubmitting} className="min-w-0 space-y-6 border-0 p-0 m-0">
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            aria-labelledby={`${section.id}-heading`}
            className="bg-white dark:bg-zinc-900 p-4 sm:p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-5 min-w-0"
          >
            <div className="space-y-1">
              <h2 id={`${section.id}-heading`} className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {section.id === "spend" ? (spend?.label ?? SPEND_LABEL) : section.title}
              </h2>
              <p className={descriptionClassName}>{section.description}</p>
            </div>

            <div className="space-y-5">
              {section.keys.map((key) => {
                const definition = definitionsByKey.get(key);
                if (!definition) {
                  return null;
                }
                if (key === "gateway.killSwitch") {
                  return (
                    <KillSwitchField
                      key={key}
                      definition={definition}
                      armed={killArmed}
                      checked={editor[key] === true}
                      saved={baseline[key] === true}
                      error={fieldErrors[key]}
                      confirmRef={confirmRef}
                      onArm={() => setKillArmed(true)}
                      onCancel={() => setKillArmed(false)}
                      onEnable={() => {
                        updateEditor(key, true);
                        setKillArmed(false);
                      }}
                      onDisable={() => updateEditor(key, false)}
                    />
                  );
                }
                return (
                  <SettingField
                    key={key}
                    definition={definition}
                    value={editor[key]}
                    error={fieldErrors[key]}
                    onChange={(next) => updateEditor(key, next)}
                  />
                );
              })}
            </div>

            {section.spendPanel ? (
              <SpendPanel spend={spend} spendError={spendError} />
            ) : null}
          </section>
        ))}

        <div>
          <button type="submit" className={`${primaryButtonClassName} w-full sm:w-auto`}>
            {isSubmitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function SettingField({
  definition,
  value,
  error,
  onChange,
}: {
  definition: SettingDefinition;
  value: EditorValue | undefined;
  error: string | undefined;
  onChange: (value: EditorValue) => void;
}) {
  const id = fieldId(definition.key);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = error ? `${descriptionId} ${errorId}` : descriptionId;

  if (definition.type === "boolean") {
    return (
      <div className="space-y-2">
        <label htmlFor={id} className="flex items-start gap-3">
          <input
            id={id}
            name={definition.key}
            type="checkbox"
            checked={value === true}
            // Content logging isn't implemented; the API refuses to turn it on.
            disabled={definition.key === "logging.contentLoggingEnabled"}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 text-zinc-900 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          />
          <span className="space-y-1">
            <span className={labelClassName}>{definition.label}</span>
            <span id={descriptionId} className={`block ${descriptionClassName}`}>
              {definition.description}
            </span>
          </span>
        </label>
        {error ? (
          <p id={errorId} className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  const control =
    definition.options && definition.options.length > 0 ? (
      <select
        id={id}
        name={definition.key}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={inputClassName}
      >
        {definition.options.map((option) => (
          <option key={option.label} value={option.value === null ? "" : String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    ) : definition.type === "string-list" || definition.key === "gateway.maintenanceMessage" ? (
      <textarea
        id={id}
        name={definition.key}
        value={text}
        rows={definition.type === "string-list" ? 4 : 3}
        maxLength={definition.key === "gateway.maintenanceMessage" ? 300 : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={inputClassName}
        placeholder={definition.type === "string-list" ? "One model name per line" : undefined}
      />
    ) : (
      <input
        id={id}
        name={definition.key}
        type={definition.type === "url" ? "url" : "text"}
        inputMode={
          definition.type === "integer" ? "numeric" : definition.type === "decimal" ? "decimal" : undefined
        }
        dir={definition.type === "url" || definition.type === "decimal" ? "ltr" : undefined}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) =>
          onChange(
            definition.key === "billing.currency" ? event.target.value.toUpperCase() : event.target.value,
          )
        }
        placeholder={definition.nullable ? "Not set" : undefined}
        className={inputClassName}
      />
    );

  return (
    <div className="space-y-1.5 min-w-0">
      <label htmlFor={id} className={labelClassName}>
        {definition.label}
      </label>
      <p id={descriptionId} className={descriptionClassName}>
        {definition.description}
      </p>
      {control}
      {error ? (
        <p id={errorId} className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function KillSwitchField({
  definition,
  armed,
  checked,
  saved,
  error,
  confirmRef,
  onArm,
  onCancel,
  onEnable,
  onDisable,
}: {
  definition: SettingDefinition;
  armed: boolean;
  checked: boolean;
  saved: boolean;
  error: string | undefined;
  confirmRef: React.RefObject<HTMLButtonElement | null>;
  onArm: () => void;
  onCancel: () => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const id = fieldId(definition.key);
  const errorId = `${id}-error`;

  return (
    <div className="space-y-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 p-4">
      <div className="space-y-1">
        <h3 id={`${id}-title`} className="text-sm font-semibold text-red-800 dark:text-red-200">
          {definition.label}
        </h3>
        <p id={`${id}-description`} className="text-sm text-red-900 dark:text-red-100">
          {definition.description} This takes effect when you save.
        </p>
      </div>

      {checked ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {saved
              ? "The kill switch is on. Public traffic is rejected."
              : "The kill switch will turn on when you save."}
          </p>
          <button type="button" className={secondaryButtonClassName} onClick={onDisable}>
            Turn off kill switch
          </button>
        </div>
      ) : armed ? (
        <div role="group" aria-labelledby={`${id}-confirm`} className="space-y-3">
          <p id={`${id}-confirm`} className="text-sm font-medium text-red-800 dark:text-red-200">
            Turn on the kill switch?
          </p>
          <p className="text-sm text-red-900 dark:text-red-100">
            After you save, every public request is rejected, including requests that have no API key.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button ref={confirmRef} type="button" className={dangerButtonClassName} onClick={onEnable}>
              Enable kill switch
            </button>
            <button type="button" className={secondaryButtonClassName} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={dangerButtonClassName} onClick={onArm} aria-describedby={`${id}-description`}>
          Turn on kill switch
        </button>
      )}

      {error ? (
        <p id={errorId} className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SpendPanel({
  spend,
  spendError,
}: {
  spend: SpendStatus | null;
  spendError: string | null;
}) {
  if (!spend) {
    return <ErrorPanel message={spendError ?? "Tracked spend could not be loaded."} />;
  }

  return (
    <div className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-5" aria-label={spend.label}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {spend.label}. Figures use the saved budget and reserve and refresh after you save. This is not
        the authoritative Google Cloud billing balance.
      </p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SpendStat label="Tracked spend (USD)" value={spend.trackedSpendUsd} />
        <SpendStat label="Estimated upstream budget" value={spend.upstreamBudget ?? "Not set"} />
        <SpendStat label="Safety reserve" value={spend.safetyReserve} />
        <SpendStat label="Usable target" value={spend.usableTarget ?? "Not set"} />
        <div className="space-y-1 sm:col-span-2">
          <dt className="text-sm text-zinc-500 dark:text-zinc-400">Threshold reached</dt>
          <dd className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {spend.thresholdReached
              ? "Yes. Tracked spend is at or above the usable target."
              : "No. Tracked spend is under the usable target, or no budget is set."}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function SpendStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 min-w-0">
      <dt className="text-sm text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd dir="ltr" className="font-mono text-base text-zinc-900 dark:text-zinc-100 break-all">
        {value}
      </dd>
    </div>
  );
}
