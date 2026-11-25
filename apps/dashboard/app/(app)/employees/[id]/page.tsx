import { Bot, ChevronRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch, getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { listPeople, listUnits } from '@/lib/structure';
import type { EmployeeDetail, MemberRow, OnboardingCheck, OrgUnit } from '@/lib/types';
import { EmployeeState } from '../employee-state';
import { Lifecycle } from './lifecycle';
import { Onboarding } from './onboarding';
import { Profile } from './profile';

export const metadata: Metadata = { title: 'AI employee' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';

  let detail: EmployeeDetail;
  let units: OrgUnit[] = [];
  let people: MemberRow[] = [];
  try {
    // Editing needs the unit and manager choices; only admins can edit.
    [detail, units, people] = await Promise.all([
      apiFetch<EmployeeDetail>(`/v1/employees/${id}`),
      isAdmin ? listUnits() : Promise.resolve([]),
      isAdmin ? listPeople({ status: 'active' }) : Promise.resolve([]),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <BackLink />
        <LoadError error={err} what="this AI employee" />
      </>
    );
  }

  const { employee, template, onboarding } = detail;
  const terminated = employee.status === 'terminated';

  return (
    <>
      <BackLink />
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <Bot className="size-6" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">{employee.display_name}</h1>
          <EmployeeState state={employee.status} />
        </div>
        <p className="mt-1 text-sm text-gray-600">
          {employee.title}
          {template ? ` · ${template.name}` : ''}
        </p>
      </div>

      <div className="grid gap-6">
        {terminated && (
          <p className="rounded-md border border-gray-300 bg-gray-100 px-4 py-3 text-sm">
            This employee was terminated. Its profile and history are kept for your records and can
            no longer be changed.
          </p>
        )}
        {onboarding.onboarding && (
          <Onboarding
            employee={employee}
            onboarding={onboarding}
            isAdmin={isAdmin}
            domain={me.organization?.domain ?? ''}
          />
        )}
        <Profile
          employee={employee}
          template={template}
          units={units}
          people={people}
          canEdit={isAdmin && !terminated}
        />
        <AccessSummary id={employee.id} check={onboarding.checks.find((c) => c.key === 'grants')} />
        {isAdmin && !terminated && <Lifecycle employee={employee} />}
      </div>
    </>
  );
}

function AccessSummary({ id, check }: { id: string; check: OnboardingCheck | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Access</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          {check?.status === 'passed' ? `Granted: ${check.detail}` : (check?.detail ?? '')}
        </p>
        <Link
          href={`/employees/${id}/access`}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-black px-3 text-sm font-medium hover:bg-gray-100"
        >
          Repositories, projects and spaces
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link href="/employees" className="mb-4 inline-block text-sm text-gray-600 hover:text-black">
      ← AI employees
    </Link>
  );
}
