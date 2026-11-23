import { ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { listPeople, listUnits } from '@/lib/structure';
import type { MemberRow, OrgUnit } from '@/lib/types';
import { PersonForm } from '../person-form';

export const metadata: Metadata = { title: 'Add person' };
export const dynamic = 'force-dynamic';

export default async function NewPersonPage() {
  const me = await getMe();
  const header = (
    <>
      <BackLink />
      <PageHeader title="Add person" description="Add someone to your organization." />
    </>
  );

  if (me.member?.role !== 'admin') {
    return (
      <>
        {header}
        <EmptyState
          icon={ShieldAlert}
          title="Only admins can add people"
          description="Ask an admin in your organization to add this person."
        />
      </>
    );
  }

  let units: OrgUnit[];
  let people: MemberRow[];
  try {
    [units, people] = await Promise.all([listUnits(), listPeople({ status: 'active' })]);
  } catch (err) {
    return (
      <>
        {header}
        <LoadError error={err} what="teams and people" />
      </>
    );
  }

  return (
    <>
      {header}
      <Card className="max-w-3xl">
        <CardContent className="py-6">
          <PersonForm units={units} people={people} />
        </CardContent>
      </Card>
    </>
  );
}

function BackLink() {
  return (
    <Link href="/people" className="mb-4 inline-block text-sm text-gray-600 hover:text-black">
      ← People
    </Link>
  );
}
