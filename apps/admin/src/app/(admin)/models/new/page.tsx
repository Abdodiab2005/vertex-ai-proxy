import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../../lib/gateway";
import type { UpstreamsListResponse } from "../../../../lib/types";
import { ErrorPanel } from "../../error-panel";
import { ModelForm } from "../model-form";

export default async function NewModelPage() {
  const res = await fetchGatewayAdmin<UpstreamsListResponse>("/upstreams");

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.upstreams)) {
    return <ErrorPanel message={`Upstreams could not be loaded. (Status: ${res.status})`} />;
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/models"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to models
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Add model</h1>
      </div>

      <ModelForm mode="create" upstreams={res.data.upstreams} />
    </div>
  );
}
