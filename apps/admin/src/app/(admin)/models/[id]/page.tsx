import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../../lib/gateway";
import type { ModelResponse, ModelRoutesResponse, PricingRulesResponse, UpstreamsListResponse } from "../../../../lib/types";
import { ErrorPanel } from "../../error-panel";
import { ModelForm } from "../model-form";
import { AliasesPanel } from "../aliases-panel";
import { PricingPanel } from "../pricing-panel";
import { RoutingPanel } from "../routing-panel";

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  
  const [modelRes, upstreamsRes, pricingRes, routesRes] = await Promise.all([
    fetchGatewayAdmin<ModelResponse>(`/models/${encodeURIComponent(id)}`),
    fetchGatewayAdmin<UpstreamsListResponse>("/upstreams"),
    fetchGatewayAdmin<PricingRulesResponse>(`/models/${encodeURIComponent(id)}/pricing`),
    fetchGatewayAdmin<ModelRoutesResponse>(`/models/${encodeURIComponent(id)}/routes`),
  ]);

  if (modelRes.status === 401 || upstreamsRes.status === 401 || pricingRes.status === 401 || routesRes.status === 401) {
    redirect("/login");
  }

  if (modelRes.status === 404) {
    notFound();
  }

  if (modelRes.status !== 200 || !modelRes.data?.model) {
    return <ErrorPanel message={`Model could not be loaded. (Status: ${modelRes.status})`} />;
  }
  
  if (upstreamsRes.status !== 200 || !upstreamsRes.data?.upstreams) {
    return <ErrorPanel message={`Upstreams could not be loaded. (Status: ${upstreamsRes.status})`} />;
  }

  const { model } = modelRes.data;
  const { upstreams } = upstreamsRes.data;
  const history = pricingRes.data?.rules || [];

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/models"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to models
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{model.publicName}</h1>
          {model.enabled ? (
            <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20">Enabled</span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-500/10 dark:bg-zinc-400/10 dark:text-zinc-400 dark:ring-zinc-400/20">Disabled</span>
          )}
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset ${model.availabilityStatus === 'available' ? 'bg-blue-50 text-blue-700 ring-blue-700/10 dark:bg-blue-900/20 dark:text-blue-400 dark:ring-blue-900/30' : 'bg-orange-50 text-orange-700 ring-orange-700/10 dark:bg-orange-900/20 dark:text-orange-400 dark:ring-orange-900/30'}`}>
            {model.availabilityStatus}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-start">
        <div className="xl:col-span-2 space-y-8">
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Edit model</h2>
            <ModelForm mode="edit" model={model} upstreams={upstreams} />
          </section>
          
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Pricing</h2>
            <PricingPanel model={model} history={history} />
          </section>

          <section className="space-y-3">
            {routesRes.status === 200 && routesRes.data ? (
              <RoutingPanel model={model} routing={routesRes.data} upstreams={upstreams} />
            ) : (
              <ErrorPanel message={`Routing could not be loaded. (Status: ${routesRes.status})`} />
            )}
          </section>
        </div>

        <div className="space-y-8">
          <section className="space-y-3">
            <AliasesPanel model={model} />
          </section>
        </div>
      </div>
    </div>
  );
}
