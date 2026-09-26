import { redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../lib/gateway";
import type { AuthMeResponse, AlertsListResponse } from "../../lib/types";
import { AdminNav } from "./admin-nav";
import { AdminSessionProvider } from "./admin-session";
import { AlertBell } from "./alert-bell";
import { ErrorPanel } from "./error-panel";
import { LogoutButton } from "./logout-button";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const authMeRes = await fetchGatewayAdmin<AuthMeResponse>("/auth/me");

  if (authMeRes.status === 401) {
    redirect("/login");
  }

  if (authMeRes.status !== 200 || !authMeRes.data) {
    return (
      <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 p-6">
        <ErrorPanel message={`Admin session could not be loaded. (Status: ${authMeRes.status})`} />
      </div>
    );
  }

  const { admin, csrfToken } = authMeRes.data;

  // Only the badge depends on this, so a failure shows no badge rather than breaking every page.
  let initialAlertCount = 0;
  try {
    const alertsRes = await fetchGatewayAdmin<AlertsListResponse>("/alerts?status=open&limit=1");
    if (alertsRes.status === 200 && alertsRes.data) {
      initialAlertCount = alertsRes.data.counts.active;
    }
  } catch {
    // Ignore errors, bell will show 0
  }

  return (
    <AdminSessionProvider csrfToken={csrfToken} email={admin.email}>
      <div className="min-h-full bg-zinc-50 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Gateway Admin</p>
            <AdminNav />
          </div>
          <div className="flex items-center gap-4 min-w-0">
            <AlertBell initialCount={initialAlertCount} csrfToken={csrfToken} />
            <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate">{admin.email}</span>
            <LogoutButton />
          </div>
        </header>
        <main className="p-6 max-w-7xl mx-auto w-full">{children}</main>
      </div>
    </AdminSessionProvider>
  );
}
