"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Dashboard", match: "exact" },
  { href: "/usage", label: "Usage", match: "prefix" },
  { href: "/upstreams", label: "Upstreams", match: "prefix" },
  { href: "/models", label: "Models", match: "prefix" },
  { href: "/api-keys", label: "API Keys", match: "prefix" },
  { href: "/alerts", label: "Alerts", match: "prefix" },
  { href: "/audit-log", label: "Audit Log", match: "prefix" },
  { href: "/settings", label: "Settings", match: "prefix" },
  { href: "/request-logs", label: "Request Logs", match: "prefix" },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Admin">
      {links.map((link) => {
        const active =
          link.match === "exact"
            ? pathname === link.href
            : pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                : "px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
