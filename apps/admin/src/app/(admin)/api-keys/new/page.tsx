import Link from "next/link";
import { ApiKeyForm } from "../api-key-form";

export default function NewApiKeyPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/api-keys"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to API keys
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Create API key</h1>
      </div>
      <ApiKeyForm mode="create" />
    </div>
  );
}