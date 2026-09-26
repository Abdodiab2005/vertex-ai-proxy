import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../../lib/gateway";
import type { KeyPresetsListResponse } from "../../../../lib/types";
import { ErrorPanel } from "../../error-panel";
import { BulkKeyForm } from "./bulk-form";

const backLinkClassName =
  "text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm";

export default async function BulkKeysPage() {
  const res = await fetchGatewayAdmin<KeyPresetsListResponse>("/key-presets");

  if (res.status === 401) {
    redirect("/login");
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.presets)) {
    return <ErrorPanel message={`Key presets could not be loaded. (Status: ${res.status})`} />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/api-keys" className={backLinkClassName}>
          Back to API keys
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Bulk generate keys</h1>
          <Link href="/api-keys/presets" className={backLinkClassName}>
            Manage presets
          </Link>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-2xl">
          Creates many keys in one step. A preset supplies the policy, overrides replace individual
          fields, and anything still unset uses the defaults from Settings.
        </p>
      </div>
      <BulkKeyForm presets={res.data.presets} />
    </div>
  );
}
