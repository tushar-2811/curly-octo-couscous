'use client';

import { ExternalLink, Pencil, Plus, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { clientFetch, ClientApiError } from '@/lib/client-api';
import type { Grant, Resource, ResourceTypeInfo } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';
import { GrantForm } from './grant-form';

const REVOKE_REASONS: Record<string, string> = {
  manual: 'revoked',
  terminated: 'revoked when the employee was terminated',
  resource_removed: 'revoked when the resource was removed',
};

export function Grants({
  employeeId,
  employeeName,
  grants,
  types,
  resources,
  canManage,
  canRevoke,
  history,
}: {
  employeeId: string;
  employeeName: string;
  grants: Grant[];
  types: ResourceTypeInfo[];
  resources: Resource[];
  canManage: boolean;
  canRevoke: boolean;
  history: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const live = grants.filter((g) => !g.revoked_at);
  const revoked = grants.filter((g) => g.revoked_at);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Access rules</CardTitle>
        {canManage && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add rule
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <div className="rounded-md border border-gray-300 p-4">
            <GrantForm
              employeeId={employeeId}
              types={types}
              resources={resources}
              onDone={() => setAdding(false)}
            />
          </div>
        )}

        {live.length === 0 && !adding ? (
          <EmptyState
            title="No access yet"
            description={
              canManage
                ? `${employeeName} can’t read or change anything until you add a rule. Grant the repositories, Jira projects and Chat spaces it should work in.`
                : `${employeeName} has no access to any repository, project or space.`
            }
            className="py-8"
          />
        ) : (
          live.length > 0 && (
            <ul className="divide-y divide-gray-300 rounded-md border border-gray-300">
              {live.map((g) => (
                <GrantItem
                  key={g.id}
                  grant={g}
                  employeeId={employeeId}
                  types={types}
                  resources={resources}
                  canManage={canManage}
                  canRevoke={canRevoke}
                />
              ))}
            </ul>
          )
        )}

        {history && revoked.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Revoked</h3>
            <ul className="divide-y divide-gray-300 rounded-md border border-gray-300 text-gray-600">
              {revoked.map((g) => (
                <li key={g.id} className="px-4 py-3 text-sm">
                  <Target grant={g} types={types} />
                  <p className="mt-0.5 text-xs">
                    <Summary grant={g} /> · {REVOKE_REASONS[g.revoke_reason ?? ''] ?? 'revoked'}{' '}
                    {formatDate(g.revoked_at!)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm">
          <Link
            href={
              history
                ? `/employees/${employeeId}/access`
                : `/employees/${employeeId}/access?history=1`
            }
            className="text-gray-600 underline underline-offset-4 hover:text-black"
            scroll={false}
          >
            {history ? 'Hide revoked rules' : 'Show revoked rules'}
          </Link>
          {history && revoked.length === 0 && (
            <span className="ml-2 text-gray-600">No rules have been revoked.</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function GrantItem({
  grant,
  employeeId,
  types,
  resources,
  canManage,
  canRevoke,
}: {
  grant: Grant;
  employeeId: string;
  types: ResourceTypeInfo[];
  resources: Resource[];
  canManage: boolean;
  canRevoke: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'edit' | 'revoke'>('view');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function revoke() {
    setPending(true);
    setError(null);
    try {
      await clientFetch(`/v1/employees/${employeeId}/grants/${grant.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setPending(false);
    }
  }

  if (mode === 'edit') {
    return (
      <li className="p-4">
        <div className="mb-4 text-sm">
          <span className="text-gray-600">Edit rule for </span>
          <Target grant={grant} types={types} />
        </div>
        <GrantForm
          employeeId={employeeId}
          types={types}
          resources={resources}
          grant={grant}
          onDone={() => setMode('view')}
        />
      </li>
    );
  }

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <Target grant={grant} types={types} />
          <p className="mt-0.5 text-xs text-gray-600">
            {grant.granted_by?.name ? `Added by ${grant.granted_by.name}` : 'Added'}{' '}
            {formatDate(grant.created_at)}
            {grant.updated_at !== grant.created_at && ` · changed ${formatDate(grant.updated_at)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Summary grant={grant} />
        </div>
        {mode === 'view' && (canManage || canRevoke) && (
          <div className="flex gap-1">
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => setMode('edit')}>
                <Pencil className="size-4" aria-hidden />
                <span className="sr-only">Edit rule</span>
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setMode('revoke')}>
              <Undo2 className="size-4" aria-hidden />
              Revoke
            </Button>
          </div>
        )}
      </div>

      {mode === 'revoke' && (
        <div className="mt-3 space-y-3 rounded-md border border-red-600 bg-red-50 p-3" role="alert">
          <p>
            <span className="font-semibold text-red-600">Revoke this rule?</span>{' '}
            {grant.effect === 'deny'
              ? 'The block is lifted, so any allow rule applies again.'
              : 'The employee loses this access at once; work that needs it stops and asks for approval.'}
          </p>
          {error && (
            <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-red-600 hover:bg-black"
              loading={pending}
              onClick={() => void revoke()}
            >
              {pending ? 'Revoking' : 'Revoke'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setMode('view');
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function Target({ grant, types }: { grant: Grant; types: ResourceTypeInfo[] }) {
  const info = types.find((t) => t.key === grant.resource_type);
  if (!grant.resource) {
    return (
      <span>
        <span className="font-medium">Every {info?.noun ?? grant.resource_type}</span>
        {grant.tags.length > 0 && (
          <span className="text-gray-600"> tagged {grant.tags.join(' or ')}</span>
        )}
      </span>
    );
  }
  const r = grant.resource;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className={cn('font-medium', r.archived && 'line-through')}>{r.name}</span>
      <span className="font-mono text-xs text-gray-600">{r.external_id}</span>
      {r.url && (
        <a href={r.url} target="_blank" rel="noreferrer" className="text-gray-600 hover:text-black">
          <ExternalLink className="size-3" aria-hidden />
          <span className="sr-only">Open {r.name}</span>
        </a>
      )}
      <span className="text-xs text-gray-600">{info?.label}</span>
    </span>
  );
}

function Summary({ grant }: { grant: Grant }) {
  if (grant.effect === 'deny') {
    return <Badge variant="danger">{grant.level === 'read' ? 'Blocked' : 'Write blocked'}</Badge>;
  }
  return (
    <>
      <Badge variant={grant.level === 'write' ? 'solid' : 'outline'}>
        {grant.level === 'write' ? 'Read and write' : 'Read'}
      </Badge>
      {grant.branches.length > 0 && (
        <span className="text-xs text-gray-600">
          push to <span className="font-mono">{grant.branches.join(', ')}</span>
        </span>
      )}
    </>
  );
}
