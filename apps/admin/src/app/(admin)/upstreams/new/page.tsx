import Link from "next/link";
import { UpstreamForm } from "../upstream-form";

export default function NewUpstreamPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/upstreams"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to upstreams
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Add upstream</h1>
      </div>
      <UpstreamForm mode="create" />
    </div>
  );
}
