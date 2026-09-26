"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAdminSession } from "./admin-session";

export function LogoutButton() {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogout = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/admin-api/auth/logout", {
        method: "POST",
        headers: {
          "x-csrf-token": csrfToken,
        },
      });

      if (res.status === 204 || res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      setError("Failed to sign out.");
      setIsLoading(false);
    } catch {
      setError("Failed to sign out.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      <button
        type="button"
        onClick={handleLogout}
        disabled={isLoading}
        className="px-3 py-1.5 text-sm font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:text-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-md disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
      >
        {isLoading ? "Signing out..." : "Sign out"}
      </button>
    </div>
  );
}
