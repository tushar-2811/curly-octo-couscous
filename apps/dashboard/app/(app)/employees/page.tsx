import { Bot, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { FormAlert } from '@/components/form-alert';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { linkErrorMessage } from '@/lib/link-errors';
import { listEmployees, listRoleTemplates } from '@/lib/structure';
import type { Employee, RoleTemplate } from '@/lib/types';
import { EmployeeState } from './employee-state';

export const metadata: Metadata = { title: 'AI employees' };
export const dynamic = 'force-dynamic';

const HIRE_LINK =
  'inline-flex h-9 items-center gap-2 rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600';

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; link_error?: string; request_id?: string }>;
}) {
  const { show, link_error: linkError, request_id: requestId } = await searchParams;
  const showEnded = show === 'all';
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';

  // A Google sign-in that could not be matched to an employee comes back here.
  const linkAlert = linkError ? (
    <div className="mb-6">
      <FormAlert
        {...linkErrorMessage(linkError.slice(0, 40))}
        requestId={requestId?.slice(0, 80)}
      />
    </div>
  ) : null;

  const header = (
    <PageHeader
      title="AI employees"
      description="Hire, onboard and manage your AI employees."
      actions={
        isAdmin ? (
          <Link href="/employees/new" className={HIRE_LINK}>
            <Plus className="size-4" aria-hidden />
            Hire AI employee
          </Link>
        ) : undefined
      }
    />
  );

  let employees: Employee[];
  let templates: RoleTemplate[];
  try {
    [employees, templates] = await Promise.all([listEmployees(), listRoleTemplates()]);
  } catch (err) {
    return (
      <>
        {header}
        {linkAlert}
        <LoadError error={err} what="AI employees" />
      </>
    );
  }
  const roleName = new Map(templates.map((t) => [t.key, t.name]));
  const ended = employees.filter((e) => e.status === 'terminated').length;
  const visible = showEnded ? employees : employees.filter((e) => e.status !== 'terminated');

  return (
    <>
      {header}
      {linkAlert}
      {visible.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No AI employees yet"
          description={
            isAdmin
              ? 'Hire your first AI engineer from a role template. During onboarding you link the company Google account your IT team created for it.'
              : 'An admin has not hired any AI employees yet.'
          }
          action={
            isAdmin ? (
              <Link href="/employees/new" className={HIRE_LINK}>
                <Plus className="size-4" aria-hidden />
                Hire AI employee
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-300 bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">AI employees</caption>
            <thead className="border-b border-gray-300 text-xs text-gray-600">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">
                  Role
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                  Team
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">
                  Manager
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300">
              {visible.map((e) => (
                <tr key={e.id} className="hover:bg-gray-100">
                  <td className="px-4 py-2.5">
                    <Link href={`/employees/${e.id}`} className="font-medium hover:underline">
                      {e.display_name}
                    </Link>
                    <div className="text-xs text-gray-600">{e.title}</div>
                  </td>
                  <td className="hidden px-4 py-2.5 sm:table-cell">
                    {roleName.get(e.role_key) ?? e.role_key}
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">{e.org_unit?.name ?? '—'}</td>
                  <td className="hidden px-4 py-2.5 lg:table-cell">{e.manager?.name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <EmployeeState state={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ended > 0 && (
        <p className="mt-4 text-sm text-gray-600">
          {showEnded ? (
            <Link href="/employees" className="underline underline-offset-4">
              Hide terminated employees
            </Link>
          ) : (
            <Link href="/employees?show=all" className="underline underline-offset-4">
              Show {ended} terminated {ended === 1 ? 'employee' : 'employees'}
            </Link>
          )}
        </p>
      )}
    </>
  );
}
