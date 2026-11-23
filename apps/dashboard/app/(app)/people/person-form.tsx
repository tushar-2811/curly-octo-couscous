'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { ClientApiError, clientFetch } from '@/lib/client-api';
import { managerOptions, unitOptions } from '@/lib/org';
import { ROLE_LABELS, type MemberRow, type OrgUnit, type PersonRole } from '@/lib/types';

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as PersonRole[]).map((r) => ({
  value: r,
  label: ROLE_LABELS[r],
}));

/**
 * Add a person (with email) or edit one. On create it goes to the new person's page; on
 * edit it calls `onDone` after the page data refreshes.
 */
export function PersonForm({
  units,
  people,
  member,
  onDone,
}: {
  units: OrgUnit[];
  people: MemberRow[];
  member?: MemberRow;
  onDone?: () => void;
}) {
  const router = useRouter();
  const editing = Boolean(member);
  const [values, setValues] = useState({
    display_name: member?.display_name ?? '',
    email: member?.email ?? '',
    title: member?.title ?? '',
    role: member?.role ?? 'member',
    org_unit_id: member?.org_unit?.id ?? '',
    manager_id: member?.manager?.id ?? '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  // Fields edited since the last failed submit; their old error is no longer shown.
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setEdited((s) => new Set(s).add(key));
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const common = {
      display_name: values.display_name,
      title: values.title.trim() || null,
      org_unit_id: values.org_unit_id || null,
      manager_id: values.manager_id || null,
      ...(member?.type === 'ai' ? {} : { role: values.role }),
    };
    try {
      if (member) {
        await clientFetch(`/v1/members/${member.id}`, { method: 'PATCH', body: common });
        router.refresh();
        onDone?.();
      } else {
        const res = await clientFetch<{ member: MemberRow }>('/v1/members', {
          method: 'POST',
          body: { ...common, email: values.email },
        });
        router.push(`/people/${res.member.id}`);
        router.refresh();
      }
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setEdited(new Set());
    } finally {
      setPending(false);
    }
  }

  const allFieldErrors = error?.fieldErrors ?? {};
  const fe = Object.fromEntries(
    Object.entries(allFieldErrors).filter(([k]) => !edited.has(k)),
  ) as Record<string, string>;
  const showAlert = error && Object.keys(allFieldErrors).length === 0;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {showAlert && (
        <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="display_name"
          label="Full name"
          value={values.display_name}
          onChange={set('display_name')}
          disabled={pending}
          error={fe.display_name}
          autoComplete="off"
          required
          maxLength={120}
        />
        {editing ? (
          <Field
            id="email"
            label="Email"
            value={values.email}
            disabled
            hint="Email can't be changed; it's how this person signs in."
          />
        ) : (
          <Field
            id="email"
            type="email"
            label="Work email"
            value={values.email}
            onChange={set('email')}
            disabled={pending}
            error={fe.email}
            hint="They join your organization the first time they sign in with this email."
            autoComplete="off"
            required
          />
        )}
        <Field
          id="title"
          label="Job title"
          value={values.title}
          onChange={set('title')}
          disabled={pending}
          error={fe.title}
          hint="Optional"
          maxLength={120}
        />
        {member?.type !== 'ai' && (
          <SelectField
            id="role"
            label="Access role"
            options={ROLE_OPTIONS}
            value={values.role}
            onChange={set('role')}
            disabled={pending}
            error={fe.role}
            hint="Admins manage people, teams and settings."
          />
        )}
        <SelectField
          id="org_unit_id"
          label="Department or team"
          options={unitOptions(units, 'None')}
          value={values.org_unit_id}
          onChange={set('org_unit_id')}
          disabled={pending}
          error={fe.org_unit_id}
        />
        <SelectField
          id="manager_id"
          label="Reports to"
          options={managerOptions(people, member?.id)}
          value={values.manager_id}
          onChange={set('manager_id')}
          disabled={pending}
          error={fe.manager_id}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          {pending ? 'Saving' : editing ? 'Save changes' : 'Add person'}
        </Button>
        {editing ? (
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push('/people')}
            disabled={pending}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
