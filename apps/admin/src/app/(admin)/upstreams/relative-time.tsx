function formatLocale(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const diffMs = date.getTime() - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absSec < 60) {
    return rtf.format(Math.round(diffMs / 1000), "second");
  }
  if (absSec < 3600) {
    return rtf.format(Math.round(diffMs / 60_000), "minute");
  }
  if (absSec < 86_400) {
    return rtf.format(Math.round(diffMs / 3_600_000), "hour");
  }
  if (absSec < 86_400 * 7) {
    return rtf.format(Math.round(diffMs / 86_400_000), "day");
  }
  return formatLocale(iso);
}

export function RelativeTime({ iso }: { iso: string | null }) {
  if (!iso) {
    return <span className="text-zinc-500 dark:text-zinc-400">Never</span>;
  }

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {formatRelative(iso)}
    </time>
  );
}
