'use client';

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientApiError, clientFetch } from '@/lib/client-api';
import { ROLE_LABELS, type MemberRow, type OrgUnit } from '@/lib/types';
import { PersonForm } from '../person-form';

/** Profile card: read-only for everyone; admins can edit and change access. */
export function PersonDetail({
  member,
  units,
  people,
  isAdmin,
  isSelf,
}: {
  member: MemberRow;
  units: OrgUnit[];
  people: MemberRow[];
  isAdmin: boolean;
  isSelf: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Profile</CardTitle>
          {isAdmin && !editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            <PersonForm
              units={units}
              people={people}
              member={member}
              onDone={() => setEditing(false)}
            />
          ) : (
            <dl className="divide-y divide-gray-300 text-sm">
              <Row label="Email" value={member.email ?? '—'} />
              <Row label="Job title" value={member.title ?? '—'} />
              {member.type === 'human' && (
                <Row label="Access role" value={member.role ? ROLE_LABELS[member.role] : '—'} />
              )}
              <Row label="Department or team" value={member.org_unit?.name ?? '—'} />
              <Row
                label="Reports to"
                value={
                  member.manager ? (
                    <Link href={`/people/${member.manager.id}`} className="hover:underline">
                      {member.manager.name}
                    </Link>
                  ) : (
                    '—'
                  )
                }
              />
              {member.type === 'human' && (
                <Row
                  label="Signed in"
                  value={member.signed_in ? 'Yes' : 'Not yet — they join on first sign-in'}
                />
              )}
              <Row label="Added" value={new Date(member.created_at).toLocaleDateString()} />
            </dl>
          )}
        </CardContent>
      </Card>
      {isAdmin && !isSelf && member.type === 'human' && <AccessCard member={member} />}
    </>
  );
}

function AccessCard({ member }: { member: MemberRow }) {
  const router = useRouter();
  const active = member.status === 'active';
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function change() {
    setPending(true);
    setError(null);
    try {
      await clientFetch(`/v1/members/${member.id}`, {
        method: 'PATCH',
        body: { status: active ? 'deactivated' : 'active' },
      });
      setConfirming(false);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
        )}
        <p className="text-sm text-gray-600">
          {active
            ? 'Deactivating signs this person out everywhere and stops them from signing in. Their history is kept.'
            : 'This person is deactivated and cannot sign in. Reactivate to restore their access.'}
        </p>
        {active && confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Deactivate {member.display_name}?</span>
            <Button size="sm" onClick={change} loading={pending}>
              {pending ? 'Deactivating' : 'Deactivate'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            onClick={active ? () => setConfirming(true) : change}
          >
            {active ? 'Deactivate' : pending ? 'Reactivating' : 'Reactivate'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-gray-600">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
