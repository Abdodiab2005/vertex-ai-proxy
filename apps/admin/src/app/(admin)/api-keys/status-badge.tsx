import {
  API_KEY_STATUS_LABELS,
  type ApiKeyStatus,
} from "../../../lib/types";

const STATUS_STYLES: Record<ApiKeyStatus, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  revoked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  expired: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  credit_exhausted: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
};

export function ApiKeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}
    >
      {API_KEY_STATUS_LABELS[status]}
    </span>
  );
}