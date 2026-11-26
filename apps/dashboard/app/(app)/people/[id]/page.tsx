import { Bot } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch, getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { listPeople, listUnits } from '@/lib/structure';
import type { DirectReport, MemberRow, OrgUnit } from '@/lib/types';
import { MemberStatus } from '../member-status';
import { PersonDetail } from './person-detail';

export const metadata: Metadata = { title: 'Person' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';
  const canAudit = isAdmin || me.member?.role === 'security_admin';

  let member: MemberRow;
  let reports: DirectReport[];
  let units: OrgUnit[] = [];
  let people: MemberRow[] = [];
  try {
    const detail = apiFetch<{ member: MemberRow; reports: DirectReport[] }>(`/v1/members/${id}`);
    // Editing needs the unit and manager choices; only admins can edit.
    const [d, u, p] = await Promise.all([
      detail,
      isAdmin ? listUnits() : Promise.resolve([]),
      isAdmin ? listPeople({ status: 'active' }) : Promise.resolve([]),
    ]);
    ({ member, reports } = d);
    units = u;
    people = p;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <BackLink />
        <LoadError error={err} what="this person" />
      </>
    );
  }

  if (member.type === 'ai') redirect(`/employees/${member.id}`);

  return (
    <>
      <BackLink />
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{member.display_name}</h1>
        <MemberStatus member={member} />
        {canAudit && (
          <Link
            href={`/audit?resource=${member.id}`}
            className="ml-auto text-sm text-gray-600 underline underline-offset-4 hover:text-black"
          >
            History
          </Link>
        )}
      </div>
      <div className="grid gap-6">
        <PersonDetail
          member={member}
          units={units}
          people={people}
          isAdmin={isAdmin}
          isSelf={me.member?.id === member.id}
        />
        <Card>
          <CardHeader>
            <CardTitle>Direct reports ({reports.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {reports.length === 0 ? (
              <p className="text-sm text-gray-600">No one reports to {member.display_name}.</p>
            ) : (
              <ul className="divide-y divide-gray-300 text-sm">
                {reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-2">
                    <Link
                      href={r.type === 'ai' ? `/employees/${r.id}` : `/people/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.display_name}
                    </Link>
                    {r.type === 'ai' && <Bot className="size-4" aria-label="AI employee" />}
                    {r.title && <span className="text-gray-600">{r.title}</span>}
                    {r.kind === 'dotted' && (
                      <span className="text-xs text-gray-600">(dotted line)</span>
                    )}
                    {r.status !== 'active' && (
                      <span className="ml-auto text-xs text-gray-600">Deactivated</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
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
