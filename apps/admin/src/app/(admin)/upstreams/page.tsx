import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import { AUTH_METHOD_LABELS, type UpstreamsListResponse } from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { RelativeTime } from "./relative-time";
import { StatusBadge } from "./status-badge";

const addButtonClassName =
  "inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-colors";

export default async function UpstreamsPage() {
  const res = await fetchGatewayAdmin<UpstreamsListResponse>("/upstreams");

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.upstreams)) {
    return <ErrorPanel message={`Upstreams could not be loaded. (Status: ${res.status})`} />;
  }

  const { upstreams } = res.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Upstreams</h1>
        <Link href="/upstreams/new" className={addButtonClassName}>
          Add upstream
        </Link>
      </div>

      {upstreams.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm text-center space-y-4">
          <p className="text-zinc-600 dark:text-zinc-400">No upstreams yet</p>
          <Link href="/upstreams/new" className={addButtonClassName}>
            Add upstream
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          <table className="min-w-full text-sm text-start">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Project / location</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Auth method</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Priority</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Enabled</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Last checked</th>
              </tr>
            </thead>
            <tbody>
              {upstreams.map((upstream) => (
                <tr
                  key={upstream.id}
                  className="border-b border-zinc-200 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link
                      href={`/upstreams/${encodeURIComponent(upstream.id)}`}
                      className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
                    >
                      {upstream.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {upstream.projectId} / {upstream.location}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {AUTH_METHOD_LABELS[upstream.authMethod]}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {upstream.priority}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    {upstream.enabled ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge status={upstream.status} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-700 dark:text-zinc-300">
                    <RelativeTime iso={upstream.lastCheckedAt} />
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
