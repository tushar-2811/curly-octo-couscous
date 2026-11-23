import type { Metadata } from 'next';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { getMe } from '@/lib/api';
import { listPeople, listUnits } from '@/lib/structure';
import type { MemberRow, OrgUnit } from '@/lib/types';
import { OrgChart } from './org-chart';

export const metadata: Metadata = { title: 'Organization' };
export const dynamic = 'force-dynamic';

export default async function OrganizationPage() {
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';

  let units: OrgUnit[];
  let people: MemberRow[];
  try {
    [units, people] = await Promise.all([listUnits(), listPeople()]);
  } catch (err) {
    return (
      <>
        <PageHeader title="Organization" />
        <LoadError error={err} what="your org chart" />
      </>
    );
  }

  // Everyone currently in the org: people who aren't deactivated and AI employees that
  // aren't terminated (including those still onboarding).
  const current = people.filter((p) => p.status !== 'deactivated' && p.status !== 'terminated');

  return (
    <>
      <PageHeader
        title="Organization"
        description="Departments and teams, and who belongs to each."
      />
      <OrgChart units={units} people={current} isAdmin={isAdmin} />
    </>
  );
}
