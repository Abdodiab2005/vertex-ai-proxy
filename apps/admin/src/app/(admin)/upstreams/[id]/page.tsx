import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../../lib/gateway";
import type { UpstreamResponse } from "../../../../lib/types";
import { ErrorPanel } from "../../error-panel";
import { RelativeTime } from "../relative-time";
import { StatusBadge } from "../status-badge";
import { TestConnection } from "../test-connection";
import { UpstreamForm } from "../upstream-form";

export default async function UpstreamDetailPage({
  params,
}: PageProps<"/upstreams/[id]">) {
  const { id } = await params;
  const res = await fetchGatewayAdmin<UpstreamResponse>(
    `/upstreams/${encodeURIComponent(id)}`,
  );

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status === 404) {
    notFound();
  }

  if (res.status !== 200 || !res.data?.upstream) {
    return <ErrorPanel message={`Upstream could not be loaded. (Status: ${res.status})`} />;
  }

  const { upstream } = res.data;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/upstreams"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to upstreams
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{upstream.name}</h1>
          <StatusBadge status={upstream.status} />
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Last checked: <RelativeTime iso={upstream.lastCheckedAt} />
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Edit upstream</h2>
        <UpstreamForm mode="edit" upstream={upstream} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Test connection</h2>
        <TestConnection upstreamId={upstream.id} />
      </section>
    </div>
  );
}
