import { ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { listPeople, listRoleTemplates, listUnits } from '@/lib/structure';
import type { MemberRow, OrgUnit, RoleTemplate } from '@/lib/types';
import { HireForm } from './hire-form';

export const metadata: Metadata = { title: 'Hire AI employee' };
export const dynamic = 'force-dynamic';

export default async function HirePage() {
  const me = await getMe();
  const header = (
    <>
      <Link href="/employees" className="mb-4 inline-block text-sm text-gray-600 hover:text-black">
        ← AI employees
      </Link>
      <PageHeader
        title="Hire AI employee"
        description="Choose a role and set up its profile. Onboarding starts as soon as it's hired."
      />
    </>
  );

  if (me.member?.role !== 'admin') {
    return (
      <>
        {header}
        <EmptyState
          icon={ShieldAlert}
          title="Only admins can hire AI employees"
          description="Ask an admin in your organization to hire one."
        />
      </>
    );
  }

  let templates: RoleTemplate[];
  let units: OrgUnit[];
  let people: MemberRow[];
  try {
    [templates, units, people] = await Promise.all([
      listRoleTemplates(),
      listUnits(),
      listPeople({ status: 'active' }),
    ]);
  } catch (err) {
    return (
      <>
        {header}
        <LoadError error={err} what="the hiring form" />
      </>
    );
  }

  return (
    <>
      {header}
      <Card className="max-w-3xl">
        <CardContent className="py-6">
          <HireForm
            templates={templates}
            units={units}
            people={people}
            domain={me.organization?.domain ?? 'your-company.com'}
          />
        </CardContent>
      </Card>
    </>
  );
}
