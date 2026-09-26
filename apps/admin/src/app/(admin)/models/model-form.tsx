"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../lib/admin-api";
import {
  isModelResponse,
  type ModelView,
  type UpstreamView,
} from "../../../lib/types";
import { useAdminSession } from "../admin-session";
import { FormAlert, FormError } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const primaryButtonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

const checkboxClassName =
  "h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100";

type ModelFormProps =
  | { mode: "create"; upstreams: UpstreamView[] }
  | { mode: "edit"; model: ModelView; upstreams: UpstreamView[] };

export function ModelForm(props: ModelFormProps) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();

  const initial = props.mode === "edit" ? props.model : null;

  const [publicName, setPublicName] = useState(initial?.publicName ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [upstreamModelName, setUpstreamModelName] = useState(initial?.upstreamModelName ?? "");
  const [upstreamId, setUpstreamId] = useState(initial?.upstreamId ?? (props.upstreams.length > 0 ? props.upstreams[0].id : ""));
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [availabilityStatus, setAvailabilityStatus] = useState<"available" | "unavailable">(initial?.availabilityStatus ?? "available");
  
  const [supportsText, setSupportsText] = useState(initial?.supportsText ?? true);
  const [supportsVision, setSupportsVision] = useState(initial?.supportsVision ?? false);
  const [supportsAudio, setSupportsAudio] = useState(initial?.supportsAudio ?? false);
  const [supportsVideo, setSupportsVideo] = useState(initial?.supportsVideo ?? false);
  const [supportsFiles, setSupportsFiles] = useState(initial?.supportsFiles ?? false);
  const [supportsTools, setSupportsTools] = useState(initial?.supportsTools ?? false);
  const [supportsStreaming, setSupportsStreaming] = useState(initial?.supportsStreaming ?? false);
  const [supportsEmbeddings, setSupportsEmbeddings] = useState(initial?.supportsEmbeddings ?? false);
  
  const [inputTokenLimit, setInputTokenLimit] = useState<string>(initial?.inputTokenLimit?.toString() ?? "");
  const [outputTokenLimit, setOutputTokenLimit] = useState<string>(initial?.outputTokenLimit?.toString() ?? "");

  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      const parsedInputTokenLimit = inputTokenLimit.trim() === "" ? null : Number.parseInt(inputTokenLimit, 10);
      const parsedOutputTokenLimit = outputTokenLimit.trim() === "" ? null : Number.parseInt(outputTokenLimit, 10);

      if (props.mode === "create") {
        const body = {
          publicName: publicName.trim(),
          displayName: displayName.trim(),
          upstreamModelName: upstreamModelName.trim(),
          upstreamId,
          enabled,
          availabilityStatus,
          supportsText,
          supportsVision,
          supportsAudio,
          supportsVideo,
          supportsFiles,
          supportsTools,
          supportsStreaming,
          supportsEmbeddings,
          inputTokenLimit: parsedInputTokenLimit,
          outputTokenLimit: parsedOutputTokenLimit,
        };

        const res = await fetchAdminApi("/models", {
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

        if (res.status !== 201 || !isModelResponse(responseBody)) {
          setError(errorMessageForStatus(res.status, responseBody));
          return;
        }

        router.push(`/models/${encodeURIComponent(responseBody.model.id)}`);
        router.refresh();
        return;
      }

      const { model } = props;
      const body: Record<string, unknown> = {};
      
      if (publicName.trim() !== model.publicName) body.publicName = publicName.trim();
      if (displayName.trim() !== model.displayName) body.displayName = displayName.trim();
      if (upstreamModelName.trim() !== model.upstreamModelName) body.upstreamModelName = upstreamModelName.trim();
      if (upstreamId !== model.upstreamId) body.upstreamId = upstreamId;
      if (enabled !== model.enabled) body.enabled = enabled;
      if (availabilityStatus !== model.availabilityStatus) body.availabilityStatus = availabilityStatus;
      
      if (supportsText !== model.supportsText) body.supportsText = supportsText;
      if (supportsVision !== model.supportsVision) body.supportsVision = supportsVision;
      if (supportsAudio !== model.supportsAudio) body.supportsAudio = supportsAudio;
      if (supportsVideo !== model.supportsVideo) body.supportsVideo = supportsVideo;
      if (supportsFiles !== model.supportsFiles) body.supportsFiles = supportsFiles;
      if (supportsTools !== model.supportsTools) body.supportsTools = supportsTools;
      if (supportsStreaming !== model.supportsStreaming) body.supportsStreaming = supportsStreaming;
      if (supportsEmbeddings !== model.supportsEmbeddings) body.supportsEmbeddings = supportsEmbeddings;
      
      if (parsedInputTokenLimit !== model.inputTokenLimit) body.inputTokenLimit = parsedInputTokenLimit;
      if (parsedOutputTokenLimit !== model.outputTokenLimit) body.outputTokenLimit = parsedOutputTokenLimit;

      if (Object.keys(body).length === 0) {
        setSuccess("No changes to save.");
        return;
      }

      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}`, {
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

      if (res.status !== 200 || !isModelResponse(responseBody)) {
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

  return (
    <form
      onSubmit={handleSubmit}
      autoComplete="off"
      className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-6 max-w-2xl"
    >
      {error && <FormError error={error} />}
      {success && <FormAlert tone="success">{success}</FormAlert>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-public-name" className={labelClassName}>
            Public name
          </label>
          <input
            id="model-public-name"
            type="text"
            required
            pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
            title="Starts with alphanumeric, followed by alphanumeric, dot, underscore, or dash. Max 128 chars."
            value={publicName}
            onChange={(e) => setPublicName(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-display-name" className={labelClassName}>
            Display name
          </label>
          <input
            id="model-display-name"
            type="text"
            required
            maxLength={100}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-upstream-name" className={labelClassName}>
            Upstream model name
          </label>
          <input
            id="model-upstream-name"
            type="text"
            required
            maxLength={100}
            value={upstreamModelName}
            onChange={(e) => setUpstreamModelName(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-upstream-id" className={labelClassName}>
            Upstream
          </label>
          <select
            id="model-upstream-id"
            required
            value={upstreamId}
            onChange={(e) => setUpstreamId(e.target.value)}
            disabled={isSubmitting || props.upstreams.length === 0}
            className={inputClassName}
          >
            {props.upstreams.length === 0 ? (
              <option value="" disabled>
                No upstreams available
              </option>
            ) : (
              props.upstreams.map((upstream) => (
                <option key={upstream.id} value={upstream.id}>
                  {upstream.name} ({upstream.provider})
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-input-limit" className={labelClassName}>
            Input token limit
          </label>
          <input
            id="model-input-limit"
            type="number"
            min={0}
            step={1}
            value={inputTokenLimit}
            onChange={(e) => setInputTokenLimit(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
            placeholder="No limit"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-output-limit" className={labelClassName}>
            Output token limit
          </label>
          <input
            id="model-output-limit"
            type="number"
            min={0}
            step={1}
            value={outputTokenLimit}
            onChange={(e) => setOutputTokenLimit(e.target.value)}
            disabled={isSubmitting}
            className={inputClassName}
            placeholder="No limit"
          />
        </div>
      </div>
      
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-2">
          Capabilities
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsText} onChange={(e) => setSupportsText(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Text
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Vision
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsAudio} onChange={(e) => setSupportsAudio(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Audio
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsVideo} onChange={(e) => setSupportsVideo(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Video
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsFiles} onChange={(e) => setSupportsFiles(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Files
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsTools} onChange={(e) => setSupportsTools(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Tools
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsStreaming} onChange={(e) => setSupportsStreaming(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Streaming
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
            <input type="checkbox" checked={supportsEmbeddings} onChange={(e) => setSupportsEmbeddings(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Embeddings
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={isSubmitting} className={checkboxClassName} /> Enabled
        </label>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="model-availability" className={labelClassName}>
            Availability Status
          </label>
          <select
            id="model-availability"
            value={availabilityStatus}
            onChange={(e) => setAvailabilityStatus(e.target.value as "available" | "unavailable")}
            disabled={isSubmitting}
            className={inputClassName}
          >
            <option value="available">Available</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </div>
      </div>

      <div className="pt-2">
        <button type="submit" disabled={isSubmitting} className={primaryButtonClassName}>
          {isSubmitting
            ? props.mode === "create"
              ? "Creating..."
              : "Saving..."
            : props.mode === "create"
              ? "Create model"
              : "Save changes"}
        </button>
      </div>
    </form>
  );
}
