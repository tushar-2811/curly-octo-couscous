import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAccessCatalog, getEmployeeAccess, listResources } from '@/lib/access';
import { apiFetch } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import type {
  AccessCatalog,
  EffectiveAccess,
  EmployeeAccess,
  EmployeeDetail,
  Resource,
} from '@/lib/types';
import { EmployeeState } from '../../employee-state';
import { CheckAccess } from './check-access';
import { Grants } from './grants';

export const metadata: Metadata = { title: 'Access' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmployeeAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ history?: string }>;
}) {
  const { id } = await params;
  const { history } = await searchParams;
  if (!UUID.test(id)) notFound();
  const showHistory = history === '1';

  let detail: EmployeeDetail;
  let access: EmployeeAccess;
  let catalog: AccessCatalog;
  let resources: Resource[];
  try {
    [detail, access, catalog, resources] = await Promise.all([
      apiFetch<EmployeeDetail>(`/v1/employees/${id}`),
      getEmployeeAccess(id, showHistory),
      getAccessCatalog(),
      listResources(),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <BackLink id={id} name="AI employee" />
        <LoadError error={err} what="this employee’s access" />
      </>
    );
  }

  const { employee } = detail;
  const terminated = employee.status === 'terminated';
  const suspended = employee.status === 'suspended';
  const canManage = access.can_manage && !terminated;

  return (
    <>
      <BackLink id={id} name={employee.display_name} />
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Access for {employee.display_name}
          </h1>
          <EmployeeState state={employee.status} />
        </div>
        <p className="mt-1 text-sm text-gray-600">
          It can use only what is granted here. Block rules always win over allow rules.
          {!access.can_manage &&
            !terminated &&
            ' Only admins and its manager can change these rules.'}
        </p>
      </div>

      <div className="grid gap-6">
        {(terminated || suspended) && (
          <p
            role="alert"
            className="rounded-md border border-red-600 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {terminated
              ? 'This employee was terminated. All of its access was revoked and can’t be granted again.'
              : 'This employee is suspended, so all of its access is off. The rules below apply again when it resumes.'}
          </p>
        )}

        <Grants
          employeeId={id}
          employeeName={employee.display_name}
          grants={access.grants}
          types={catalog.resource_types}
          resources={resources}
          canManage={canManage}
          canRevoke={access.can_revoke && !terminated}
          history={showHistory}
        />

        {!terminated && (
          <Effective effective={access.effective} catalog={catalog} suspended={suspended} />
        )}

        {!terminated && resources.length > 0 && (
          <CheckAccess
            employeeId={id}
            resources={resources}
            actions={catalog.actions}
            types={catalog.resource_types}
          />
        )}
      </div>
    </>
  );
}

function Effective({
  effective,
  catalog,
  suspended,
}: {
  effective: EffectiveAccess[];
  catalog: AccessCatalog;
  suspended: boolean;
}) {
  const label = new Map(catalog.resource_types.map((t) => [t.key, t.label]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>What it can do now</CardTitle>
      </CardHeader>
      <CardContent>
        {effective.length === 0 ? (
          <p className="text-sm text-gray-600">
            {suspended
              ? 'Nothing while it is suspended.'
              : 'Nothing yet. Rules on every item of a type also cover items added later.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Effective permissions</caption>
              <thead className="border-b border-gray-300 text-xs text-gray-600">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Resource
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Access
                  </th>
                  <th scope="col" className="hidden py-2 font-medium sm:table-cell">
                    Limits
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-300">
                {effective.map((e) => (
                  <tr key={e.resource.id}>
                    <td className="py-2 pr-4">
                      <div className="font-medium">{e.resource.name}</div>
                      <div className="text-xs text-gray-600">
                        {label.get(e.resource.type)} ·{' '}
                        <span className="font-mono">{e.resource.external_id}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      {e.level === null ? (
                        <Badge variant="danger">Blocked</Badge>
                      ) : (
                        <Badge variant={e.level === 'write' ? 'solid' : 'outline'}>
                          {e.level === 'write' ? 'Read and write' : 'Read'}
                        </Badge>
                      )}
                    </td>
                    <td className="hidden py-2 text-xs text-gray-600 sm:table-cell">
                      {[
                        e.branches ? `Push to ${e.branches.join(', ')}` : null,
                        e.limited_by_deny && e.level !== null ? 'Write blocked by a rule' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BackLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/employees/${id}`}
      className="mb-4 inline-block text-sm text-gray-600 hover:text-black"
    >
      ← {name}
    </Link>
  );
}
