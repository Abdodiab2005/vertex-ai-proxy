import type { ReactNode } from "react";
import { ALLOWED_ENDPOINTS, type ApiKeyView, type ModelView, type UpstreamView } from "../../../lib/types";
import type { UsageSearch } from "./window";

const fieldClass =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 w-full";

export function UsageFilters({
  keys,
  models,
  upstreams,
  values,
}: {
  keys: ApiKeyView[];
  models: ModelView[];
  upstreams: UpstreamView[];
  values: UsageSearch;
}) {
  const formKey = [
    values.apiKeyId ?? "",
    values.modelId ?? "",
    values.upstreamId ?? "",
    values.status ?? "",
    values.endpoint ?? "",
    values.from ?? "",
    values.to ?? "",
  ].join("|");

  return (
    <form
      key={formKey}
      method="get"
      action="/usage"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm"
    >
      <Field id="usage-key" label="API key">
        <select id="usage-key" name="apiKeyId" defaultValue={values.apiKeyId ?? ""} className={fieldClass}>
          <option value="">All keys</option>
          {keys.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name} ({key.keyPrefix})
            </option>
          ))}
        </select>
      </Field>

      <Field id="usage-model" label="Model">
        <select id="usage-model" name="modelId" defaultValue={values.modelId ?? ""} className={fieldClass}>
          <option value="">All models</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.publicName}
            </option>
          ))}
        </select>
      </Field>

      <Field id="usage-upstream" label="Upstream">
        <select
          id="usage-upstream"
          name="upstreamId"
          defaultValue={values.upstreamId ?? ""}
          className={fieldClass}
        >
          <option value="">All upstreams</option>
          {upstreams.map((upstream) => (
            <option key={upstream.id} value={upstream.id}>
              {upstream.name}
            </option>
          ))}
        </select>
      </Field>

      <Field id="usage-status" label="Status">
        <select id="usage-status" name="status" defaultValue={values.status ?? ""} className={fieldClass}>
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="partial">Partial</option>
        </select>
      </Field>

      <Field id="usage-endpoint" label="Endpoint">
        <input
          id="usage-endpoint"
          name="endpoint"
          type="text"
          list="usage-endpoints"
          defaultValue={values.endpoint ?? ""}
          placeholder="generateContent"
          className={fieldClass}
        />
        <datalist id="usage-endpoints">
          {ALLOWED_ENDPOINTS.map((endpoint) => (
            <option key={endpoint} value={endpoint} />
          ))}
        </datalist>
      </Field>

      <Field id="usage-from" label="From (UTC date)">
        <input id="usage-from" name="from" type="date" defaultValue={values.from ?? ""} className={fieldClass} />
      </Field>

      <Field id="usage-to" label="To (UTC date, included)">
        <input id="usage-to" name="to" type="date" defaultValue={values.to ?? ""} className={fieldClass} />
      </Field>

      <div className="flex flex-wrap items-end gap-3">
        <button
          type="submit"
          className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        >
          Apply filters
        </button>
        <a
          href="/usage"
          className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
        >
          Clear
        </a>
      </div>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        {label}
      </label>
      {children}
    </div>
  );
}
