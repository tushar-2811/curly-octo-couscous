import { CheckCircle2, XCircle } from 'lucide-react';
import { Suspense } from 'react';
import { PageHeader } from '@/components/page-header';
import { RetryButton } from '@/components/retry-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiFetch, getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const me = await getMe();
  const firstName = me.member?.display_name.split(' ')[0] ?? '';
  return (
    <>
      <PageHeader
        title={firstName ? `Welcome, ${firstName}` : 'Overview'}
        description={`${me.organization?.name ?? 'Your organization'} · your AI workforce at a glance.`}
      />
      <div className="grid gap-6">
        <Suspense fallback={<SystemStatusSkeleton />}>
          <SystemStatus />
        </Suspense>
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              title="No activity yet"
              description="Once you hire an AI employee and assign work in Google Chat, tasks and progress appear here."
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

interface Meta {
  service: string;
  version: string;
  env: string;
}

interface Readiness {
  status: string;
  checks: Record<string, 'ok' | 'failed'>;
}

/** Calls the API directly, so this card also shows whether the dashboard can reach it. */
async function SystemStatus() {
  let meta: Meta;
  let readiness: Readiness | undefined;
  let degraded: ApiError | undefined;
  try {
    meta = await apiFetch<Meta>('/v1/meta');
    try {
      readiness = await apiFetch<Readiness>('/readyz');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'dependency_unavailable') degraded = err;
      else throw err;
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return (
      <ErrorState
        title={err.title}
        description={err.detail ?? 'The platform status could not be loaded.'}
        requestId={err.requestId}
        action={<RetryButton />}
      />
    );
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Platform status</CardTitle>
        <span className="font-mono text-xs text-gray-600">
          v{meta.version} · {meta.env}
        </span>
      </CardHeader>
      <CardContent>
        {degraded ? (
          <ErrorState
            title="Degraded"
            description={degraded.detail ?? 'A dependency is unavailable.'}
            requestId={degraded.requestId}
            action={<RetryButton />}
          />
        ) : (
          <ul className="divide-y divide-gray-300">
            <StatusRow name="API" ok />
            {Object.entries(readiness?.checks ?? {}).map(([name, state]) => (
              <StatusRow key={name} name={name} ok={state === 'ok'} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusRow({ name, ok }: { name: string; ok: boolean }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-center justify-between py-2.5 text-sm">
      <span className="capitalize">{name}</span>
      <span className="flex items-center gap-1.5">
        <Icon className="size-4" aria-hidden strokeWidth={1.75} />
        {ok ? 'Operational' : 'Unavailable'}
      </span>
    </li>
  );
}

function SystemStatusSkeleton() {
  return (
    <Card aria-busy>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Platform status</CardTitle>
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent className="space-y-3">
        <span className="sr-only">Loading platform status</span>
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </CardContent>
    </Card>
  );
}
