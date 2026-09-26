import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fetchGatewayAdmin } from "../../../../lib/gateway";
import type {
  ApiKeyDetailResponse,
  AuditLogsListResponse,
  CreditsListResponse,
  LimitsUsageResponse,
  RequestLogsListResponse,
  UsageSummaryResponse,
} from "../../../../lib/types";
import {
  isCreditsListResponse,
  isLimitsUsageResponse,
  isRequestLogsListResponse,
  isUsageSummaryResponse,
} from "../../../../lib/types";
import { ErrorPanel } from "../../error-panel";
import { RelativeTime } from "../../upstreams/relative-time";
import { ApiKeyStatusBadge } from "../status-badge";
import { ApiKeyStatusActions } from "./status-actions";
import {
  ApiKeySectionNav,
  AuditSection,
  CreditSection,
  ErrorsSection,
  IpSection,
  lastSeenClientIp,
  LimitsSection,
  ModelsSection,
  RequestHistorySection,
  sectionClassName,
  UsageSection,
} from "./detail-sections";

const CREDIT_PAGE_SIZE = 20;
const LOG_LIMIT = 20;

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ creditsPage?: string }>;
}

export default async function ApiKeyDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { creditsPage } = await searchParams;
  const page = positivePage(creditsPage);
  const encodedId = encodeURIComponent(id);

  const keyRes = await fetchGatewayAdmin<ApiKeyDetailResponse>(`/api-keys/${encodedId}`);
  if (keyRes.status === 401) {
    redirect("/login");
  }
  if (keyRes.status === 404) {
    notFound();
  }
  if (keyRes.status !== 200 || !keyRes.data?.apiKey) {
    return <ErrorPanel message={`API key could not be loaded. (Status: ${keyRes.status})`} />;
  }

  const { apiKey } = keyRes.data;
  const deletable = keyRes.data.deletable === true;

  const creditsParams = new URLSearchParams({
    limit: String(CREDIT_PAGE_SIZE),
    offset: String((page - 1) * CREDIT_PAGE_SIZE),
  });

  const [creditsRes, usageRes, limitsRes, requestsRes, errorsRes, auditRes] = await Promise.all([
    fetchGatewayAdmin<CreditsListResponse>(`/api-keys/${encodedId}/credits?${creditsParams.toString()}`),
    fetchGatewayAdmin<UsageSummaryResponse>(`/api-keys/${encodedId}/usage-summary`),
    fetchGatewayAdmin<LimitsUsageResponse>(`/api-keys/${encodedId}/limits-usage`),
    fetchGatewayAdmin<RequestLogsListResponse>(
      `/request-logs?apiKeyId=${encodedId}&limit=${LOG_LIMIT}`,
    ),
    fetchGatewayAdmin<RequestLogsListResponse>(
      `/request-logs?apiKeyId=${encodedId}&status=error&limit=${LOG_LIMIT}`,
    ),
    fetchGatewayAdmin<AuditLogsListResponse>(
      `/audit-logs?entityType=api_key&entityId=${encodedId}&limit=${LOG_LIMIT}`,
    ),
  ]);

  for (const res of [creditsRes, usageRes, limitsRes, requestsRes, errorsRes, auditRes]) {
    if (res.status === 401) {
      redirect("/login");
    }
  }

  const credits = creditsRes.status === 200 && creditsRes.data && isCreditsListResponse(creditsRes.data)
    ? creditsRes.data
    : null;
  const usage = usageRes.status === 200 && usageRes.data && isUsageSummaryResponse(usageRes.data)
    ? usageRes.data
    : null;
  const limits = limitsRes.status === 200 && limitsRes.data && isLimitsUsageResponse(limitsRes.data)
    ? limitsRes.data
    : null;
  const requests = requestsRes.status === 200 && requestsRes.data && isRequestLogsListResponse(requestsRes.data)
    ? requestsRes.data.entries
    : null;
  const errors = errorsRes.status === 200 && errorsRes.data && isRequestLogsListResponse(errorsRes.data)
    ? errorsRes.data.entries
    : null;
  const audits = auditRes.status === 200 && auditRes.data && Array.isArray(auditRes.data.entries)
    ? auditRes.data.entries
    : null;

  const section = sectionClassName();

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/api-keys"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 rounded-sm"
        >
          Back to API keys
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{apiKey.name}</h1>
          <ApiKeyStatusBadge status={apiKey.status} />
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Key prefix:{" "}
          <code className="font-mono text-zinc-700 dark:text-zinc-300" dir="ltr">
            {apiKey.keyPrefix}...
          </code>
        </p>
      </div>

      <ApiKeySectionNav />

      <section id="overview" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Overview</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Created" iso={apiKey.createdAt} />
          <Stat label="Updated" iso={apiKey.updatedAt} />
          <Stat label="Last used" iso={apiKey.lastUsedAt} />
          <Stat label="Expires" iso={apiKey.expiresAt} />
        </div>
        {apiKey.description && (
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{apiKey.description}</p>
        )}
        <ApiKeyStatusActions apiKey={apiKey} deletable={deletable} />
      </section>

      <section id="credit" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Credit</h2>
        {credits === null ? (
          <ErrorPanel message={`Credit could not be loaded. (Status: ${creditsRes.status})`} />
        ) : (
          <CreditSection apiKeyId={apiKey.id} credits={credits} page={page} pageSize={CREDIT_PAGE_SIZE} />
        )}
      </section>

      <section id="usage" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Usage</h2>
        {usage === null ? (
          <ErrorPanel message={`Usage could not be loaded. (Status: ${usageRes.status})`} />
        ) : (
          <UsageSection summary={usage} />
        )}
      </section>

      <section id="limits" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Limits</h2>
        {limits === null ? (
          <ErrorPanel message={`Limits could not be loaded. (Status: ${limitsRes.status})`} />
        ) : (
          <LimitsSection apiKeyId={apiKey.id} limitsUsage={limits} />
        )}
      </section>

      <section id="models" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Allowed models</h2>
        <ModelsSection apiKey={apiKey} />
      </section>

      <section id="requests" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Request history</h2>
        {requests === null ? (
          <ErrorPanel message={`Request history could not be loaded. (Status: ${requestsRes.status})`} />
        ) : (
          <RequestHistorySection apiKeyId={apiKey.id} entries={requests} />
        )}
      </section>

      <section id="errors" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Errors</h2>
        {errors === null ? (
          <ErrorPanel message={`Errors could not be loaded. (Status: ${errorsRes.status})`} />
        ) : (
          <ErrorsSection apiKeyId={apiKey.id} entries={errors} />
        )}
      </section>

      <section id="ip" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">IP information</h2>
        <IpSection apiKey={apiKey} lastClientIp={requests === null ? null : lastSeenClientIp(requests)} />
        {requests === null && (
          <ErrorPanel message={`The last seen client IP could not be loaded. (Status: ${requestsRes.status})`} />
        )}
      </section>

      <section id="audit" className={section}>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Audit history</h2>
        {audits === null ? (
          <ErrorPanel message={`Audit history could not be loaded. (Status: ${auditRes.status})`} />
        ) : (
          <AuditSection apiKeyId={apiKey.id} entries={audits} />
        )}
      </section>
    </div>
  );
}

function Stat({ label, iso }: { label: string; iso: string | null }) {
  return (
    <div className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        <RelativeTime iso={iso} />
      </p>
    </div>
  );
}

function positivePage(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return 1;
  }
  return parsed;
}
