'use client';

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { TextareaField } from '@/components/ui/textarea-field';
import { clientFetch } from '@/lib/client-api';
import { managerOptions, unitOptions } from '@/lib/org';
import type { Employee, MemberRow, OrgUnit, RoleTemplate } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';

export function Profile({
  employee,
  template,
  units,
  people,
  canEdit,
}: {
  employee: Employee;
  template: RoleTemplate | null;
  units: OrgUnit[];
  people: MemberRow[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Profile</CardTitle>
        {canEdit && !editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <EditForm
            employee={employee}
            units={units}
            people={people}
            onDone={() => setEditing(false)}
          />
        ) : (
          <dl className="divide-y divide-gray-300 text-sm">
            <Row label="Role" value={template?.name ?? employee.role_key} />
            <Row label="Job title" value={employee.title ?? '—'} />
            <Row label="Company account" value={employee.email ?? 'Not entered yet'} />
            <Row label="Department or team" value={employee.org_unit?.name ?? '—'} />
            <Row
              label="Manager"
              value={
                employee.manager ? (
                  <Link href={`/people/${employee.manager.id}`} className="hover:underline">
                    {employee.manager.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Row
              label="Capacity"
              value={`${employee.max_concurrency} at once · up to ${employee.max_open_tasks} open tasks`}
            />
            {template && (
              <Row
                label="Capabilities"
                value={
                  <span className="font-mono text-xs">{template.capabilities.join(', ')}</span>
                }
              />
            )}
            <div className="py-2.5">
              <dt className="text-gray-600">Instructions</dt>
              <dd className="mt-2 space-y-2">
                {template && (
                  <p className="rounded-md bg-gray-100 px-3 py-2 text-gray-600">
                    <span className="font-medium text-black">From the role: </span>
                    {template.base_instructions}
                  </p>
                )}
                <p className="whitespace-pre-wrap">
                  {employee.instructions || (
                    <span className="text-gray-600">No team-specific instructions.</span>
                  )}
                </p>
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function EditForm({
  employee,
  units,
  people,
  onDone,
}: {
  employee: Employee;
  units: OrgUnit[];
  people: MemberRow[];
  onDone: () => void;
}) {
  const router = useRouter();
  const form = useFormErrors();
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState({
    display_name: employee.display_name,
    title: employee.title ?? '',
    org_unit_id: employee.org_unit?.id ?? '',
    manager_id: employee.manager?.id ?? '',
    instructions: employee.instructions,
    max_concurrency: String(employee.max_concurrency),
    max_open_tasks: String(employee.max_open_tasks),
  });
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    form.touch(key);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    form.clear();
    try {
      await clientFetch(`/v1/employees/${employee.id}`, {
        method: 'PATCH',
        body: {
          display_name: values.display_name,
          title: values.title.trim() || null,
          org_unit_id: values.org_unit_id || null,
          manager_id: values.manager_id || null,
          instructions: values.instructions,
          max_concurrency: Number(values.max_concurrency),
          max_open_tasks: Number(values.max_open_tasks),
        },
      });
      router.refresh();
      onDone();
    } catch (err) {
      form.fail(err);
    } finally {
      setPending(false);
    }
  }

  const fe = form.fieldErrors;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {form.alert && (
        <FormAlert
          title={form.alert.title}
          detail={form.alert.detail}
          requestId={form.alert.requestId}
        />
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="display_name"
          label="Name"
          value={values.display_name}
          onChange={set('display_name')}
          disabled={pending}
          error={fe.display_name}
          maxLength={120}
        />
        <Field
          id="title"
          label="Job title"
          value={values.title}
          onChange={set('title')}
          disabled={pending}
          error={fe.title}
          maxLength={120}
        />
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
          label="Manager"
          options={managerOptions(people, employee.id)}
          value={values.manager_id}
          onChange={set('manager_id')}
          disabled={pending}
          error={fe.manager_id}
        />
        <Field
          id="max_concurrency"
          type="number"
          inputMode="numeric"
          min={1}
          max={10}
          label="Tasks at once"
          value={values.max_concurrency}
          onChange={set('max_concurrency')}
          disabled={pending}
          error={fe.max_concurrency}
          hint="1 to 10"
        />
        <Field
          id="max_open_tasks"
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          label="Open tasks"
          value={values.max_open_tasks}
          onChange={set('max_open_tasks')}
          disabled={pending}
          error={fe.max_open_tasks}
          hint="1 to 50, including waiting ones"
        />
      </div>
      <TextareaField
        id="instructions"
        label="Team-specific instructions"
        value={values.instructions}
        onChange={set('instructions')}
        disabled={pending}
        error={fe.instructions}
        maxLength={8000}
      />
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          {pending ? 'Saving' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-gray-600">{label}</dt>
      <dd className="sm:text-right">{value}</dd>
    </div>
  );
}
