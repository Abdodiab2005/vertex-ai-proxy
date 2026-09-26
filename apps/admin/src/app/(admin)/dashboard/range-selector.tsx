import Link from "next/link";
import type { AnalyticsRangeName } from "../../../lib/types";

const OPTIONS: { range: AnalyticsRangeName; label: string }[] = [
  { range: "24h", label: "24 hours" },
  { range: "7d", label: "7 days" },
  { range: "30d", label: "30 days" },
];

export function RangeSelector({ range }: { range: AnalyticsRangeName | null }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-1">
      {OPTIONS.map((option) => {
        const active = option.range === range;
        return (
          <Link
            key={option.range}
            href={`/dashboard?range=${option.range}`}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
                : "px-3 py-1.5 text-sm font-medium rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
            }
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}
