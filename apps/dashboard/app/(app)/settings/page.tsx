import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMe } from '@/lib/api';
import { ROLE_LABELS } from '@/lib/types';
import { OrgNameForm } from './org-name-form';
import { formatDate } from '@/lib/utils';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // The layout already loaded and checked this; getMe is memoized per request.
  const me = await getMe();
  const org = me.organization!;
  const member = me.member!;
  const isAdmin = member.role === 'admin';

  return (
    <>
      <PageHeader title="Settings" description="Your organization and account." />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {isAdmin ? (
              <OrgNameForm initialName={org.name} />
            ) : (
              <Row label="Name" value={org.name} />
            )}
            <dl className="divide-y divide-gray-300 border-t border-gray-300 text-sm">
              <Row label="Domain" value={<span className="font-mono">{org.domain}</span>} />
              <Row label="Created" value={formatDate(org.created_at)} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-gray-300 text-sm">
              <Row label="Name" value={member.display_name} />
              <Row label="Email" value={me.user.email} />
              <Row label="Role" value={member.role ? ROLE_LABELS[member.role] : '—'} />
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
