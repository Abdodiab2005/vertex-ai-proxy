import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../lib/gateway";
import { isSettingsResponse, isSpendStatus } from "../../../lib/types";
import { ErrorPanel } from "../error-panel";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const [settingsRes, spendRes] = await Promise.all([
    fetchGatewayAdmin<unknown>("/settings"),
    fetchGatewayAdmin<unknown>("/settings/spend"),
  ]);

  if (settingsRes.status === 401 || spendRes.status === 401) {
    redirect("/login");
  }

  if (!isSettingsResponse(settingsRes.data)) {
    return <ErrorPanel message={`Settings could not be loaded. (Status: ${settingsRes.status})`} />;
  }

  const spend = isSpendStatus(spendRes.data) ? spendRes.data : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Global controls for the public gateway. A save applies on this server immediately and on
          other servers within five seconds.
        </p>
      </div>
      <SettingsForm
        settings={settingsRes.data.settings}
        definitions={settingsRes.data.definitions}
        spend={spend}
        spendError={
          spend ? null : `Tracked spend could not be loaded. (Status: ${spendRes.status})`
        }
      />
    </div>
  );
}
