import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import type { ModelsListResponse, UpstreamsListResponse } from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { SyncModels } from "./sync-models";

const addButtonClassName =
  "inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-colors";

const tagClassName = "inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; enabled?: string; availability?: string }>;
}) {
  const params = await searchParams;
  
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.enabled) q.set("enabled", params.enabled);
  if (params.availability) q.set("availability", params.availability);
  
  const queryString = q.toString() ? `?${q.toString()}` : "";
  const [res, upstreamsRes] = await Promise.all([
    fetchGatewayAdmin<ModelsListResponse>(`/models${queryString}`),
    fetchGatewayAdmin<UpstreamsListResponse>("/upstreams"),
  ]);

  if (res.status === 401 || upstreamsRes.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.models)) {
    return <ErrorPanel message={`Models could not be loaded. (Status: ${res.status})`} />;
  }

  const { models } = res.data;
  const upstreams =
    upstreamsRes.status === 200 && upstreamsRes.data && Array.isArray(upstreamsRes.data.upstreams)
      ? upstreamsRes.data.upstreams
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Models</h1>
        <Link href="/models/new" className={addButtonClassName}>
          Add model
        </Link>
      </div>

      <SyncModels upstreams={upstreams} />
      
      <div className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <form className="flex flex-wrap gap-4 items-end" action="/models">
          <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
            <label htmlFor="search" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Search</label>
            <input type="text" id="search" name="search" defaultValue={params.search} className="px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900" placeholder="Model name..." />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="enabled" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Enabled</label>
            <select id="enabled" name="enabled" defaultValue={params.enabled} className="px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900">
              <option value="">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="availability" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Availability</label>
            <select id="availability" name="availability" defaultValue={params.availability} className="px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900">
              <option value="">Any</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </div>
          <button type="submit" className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 rounded-md hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-colors">
            Filter
          </button>
          {(params.search || params.enabled || params.availability) && (
            <Link href="/models" className="px-4 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300">Clear</Link>
          )}
        </form>
      </div>

      {models.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center space-y-4">
          <p className="text-zinc-600 dark:text-zinc-400">No models found</p>
          {!params.search && !params.enabled && !params.availability && (
            <Link href="/models/new" className={addButtonClassName}>
              Add model
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Display Name</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Upstream</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Input / Output ($ per 1M)</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const inputPrice = model.currentPricing.find(p => p.billingDimension === "input_tokens");
                const outputPrice = model.currentPricing.find(p => p.billingDimension === "output_tokens");
                
                const inputPriceDisplay = inputPrice && inputPrice.unitSize === "1000000" ? inputPrice.price : "—";
                const outputPriceDisplay = outputPrice && outputPrice.unitSize === "1000000" ? outputPrice.price : "—";
                
                return (
                <tr
                  key={model.id}
                  className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1 items-start">
                      <Link
                        href={`/models/${encodeURIComponent(model.id)}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
                      >
                        {model.publicName}
                      </Link>
                      {model.aliases.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {model.aliases.map(a => <span key={a} className={tagClassName}>{a}</span>)}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {model.displayName}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {model.upstream.name}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-flex self-start items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${model.enabled ? 'bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20' : 'bg-zinc-50 text-zinc-600 ring-zinc-500/10 dark:bg-zinc-400/10 dark:text-zinc-400 dark:ring-zinc-400/20'}`}>
                        {model.enabled ? "Enabled" : "Disabled"}
                      </span>
                      <span className={`inline-flex self-start items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${model.availabilityStatus === 'available' ? 'bg-blue-50 text-blue-700 ring-blue-700/10 dark:bg-blue-900/20 dark:text-blue-400 dark:ring-blue-900/30' : 'bg-orange-50 text-orange-700 ring-orange-700/10 dark:bg-orange-900/20 dark:text-orange-400 dark:ring-orange-900/30'}`}>
                        {model.availabilityStatus}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300 font-mono text-xs">
                    {inputPriceDisplay} / {outputPriceDisplay}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {model.supportsText && <span className={tagClassName} title="Text">T</span>}
                      {model.supportsVision && <span className={tagClassName} title="Vision">V</span>}
                      {model.supportsAudio && <span className={tagClassName} title="Audio">A</span>}
                      {model.supportsVideo && <span className={tagClassName} title="Video">Vi</span>}
                      {model.supportsFiles && <span className={tagClassName} title="Files">F</span>}
                      {model.supportsTools && <span className={tagClassName} title="Tools">To</span>}
                      {model.supportsStreaming && <span className={tagClassName} title="Streaming">S</span>}
                      {model.supportsEmbeddings && <span className={tagClassName} title="Embeddings">E</span>}
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
