'use client';

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { TextareaField } from '@/components/ui/textarea-field';
import { clientFetch } from '@/lib/client-api';
import { managerOptions, unitOptions } from '@/lib/org';
import type { Employee, MemberRow, OrgUnit, RoleTemplate } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';
import { cn } from '@/lib/utils';

export function HireForm({
  templates,
  units,
  people,
  domain,
}: {
  templates: RoleTemplate[];
  units: OrgUnit[];
  people: MemberRow[];
  domain: string;
}) {
  const router = useRouter();
  const form = useFormErrors();
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState({
    role_key: '',
    display_name: '',
    title: '',
    org_unit_id: '',
    manager_id: '',
    email: '',
    instructions: '',
    max_concurrency: '2',
  });
  const template = templates.find((t) => t.key === values.role_key);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    form.touch(key);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    form.clear();
    try {
      const { employee } = await clientFetch<{ employee: Employee }>('/v1/employees', {
        method: 'POST',
        body: {
          role_key: values.role_key,
          display_name: values.display_name,
          title: values.title.trim() || null,
          org_unit_id: values.org_unit_id || null,
          manager_id: values.manager_id || null,
          email: values.email.trim(),
          instructions: values.instructions,
          max_concurrency: Number(values.max_concurrency),
        },
      });
      router.push(`/employees/${employee.id}`);
      router.refresh();
    } catch (err) {
      form.fail(err);
      setPending(false);
    }
  }

  const fe = form.fieldErrors;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      {form.alert && (
        <FormAlert
          title={form.alert.title}
          detail={form.alert.detail}
          requestId={form.alert.requestId}
        />
      )}

      <fieldset aria-describedby={fe.role_key ? 'role_key-error' : undefined}>
        <legend className="text-sm font-semibold">1. Role</legend>
        <p className="mt-1 text-xs text-gray-600">
          The template sets the default title, instructions, capabilities and the tools the employee
          needs.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {templates.map((t) => {
            const selected = t.key === values.role_key;
            return (
              <label
                key={t.key}
                className={cn(
                  'relative flex cursor-pointer flex-col gap-1 rounded-md border p-4 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-black',
                  selected ? 'border-2 border-black' : 'border-gray-300 hover:border-black',
                  fe.role_key && !selected && 'border-red-600',
                )}
              >
                <input
                  type="radio"
                  name="role_key"
                  value={t.key}
                  checked={selected}
                  onChange={set('role_key')}
                  disabled={pending}
                  className="sr-only"
                />
                <span className="flex items-center justify-between font-medium">
                  {t.name}
                  {selected && <Check className="size-4" aria-hidden />}
                </span>
                <span className="text-gray-600">{t.summary}</span>
              </label>
            );
          })}
        </div>
        {fe.role_key && (
          <p id="role_key-error" role="alert" className="mt-2 text-xs font-semibold text-red-600">
            Error: {fe.role_key}
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-5">
        <legend className="text-sm font-semibold">2. Profile</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="display_name"
            label="Name"
            value={values.display_name}
            onChange={set('display_name')}
            disabled={pending}
            error={fe.display_name}
            hint="How colleagues will see it in Chat, Jira and GitHub."
            autoComplete="off"
            maxLength={120}
          />
          <Field
            id="title"
            label="Job title"
            value={values.title}
            onChange={set('title')}
            disabled={pending}
            error={fe.title}
            placeholder={template?.default_title ?? 'From the role'}
            hint="Optional. Leave empty to use the role's title."
            maxLength={120}
          />
          <SelectField
            id="org_unit_id"
            label="Department or team"
            options={unitOptions(units, 'Choose later')}
            value={values.org_unit_id}
            onChange={set('org_unit_id')}
            disabled={pending}
            error={fe.org_unit_id}
          />
          <SelectField
            id="manager_id"
            label="Manager"
            options={managerOptions(people)}
            value={values.manager_id}
            onChange={set('manager_id')}
            disabled={pending}
            error={fe.manager_id}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-5">
        <legend className="text-sm font-semibold">3. Company account</legend>
        <Field
          id="email"
          type="email"
          label="Google Workspace account"
          value={values.email}
          onChange={set('email')}
          disabled={pending}
          error={fe.email}
          placeholder={`frontend-ai@${domain}`}
          hint={`Optional now. Create the account in your Google Admin console first; it must be on @${domain}. You'll link it with Google sign-in during onboarding.`}
          autoComplete="off"
          className="max-w-md"
        />
      </fieldset>

      <fieldset className="space-y-5">
        <legend className="text-sm font-semibold">4. Instructions</legend>
        <TextareaField
          id="instructions"
          label="Team-specific instructions"
          value={values.instructions}
          onChange={set('instructions')}
          disabled={pending}
          error={fe.instructions}
          maxLength={8000}
          placeholder="For example: Follow our React and Tailwind conventions. Always add Storybook stories."
          hint={
            template
              ? `Added to the role's own instructions: “${template.base_instructions}”`
              : 'Added to the role’s own instructions. Optional.'
          }
        />
        <Field
          id="max_concurrency"
          type="number"
          inputMode="numeric"
          min={1}
          max={10}
          label="Tasks it can work on at once"
          value={values.max_concurrency}
          onChange={set('max_concurrency')}
          disabled={pending}
          error={fe.max_concurrency}
          hint="1 to 10. Each running task uses its own environment."
          className="max-w-48"
        />
      </fieldset>

      <div className="flex gap-2 border-t border-gray-300 pt-6">
        <Button type="submit" loading={pending}>
          {pending ? 'Hiring' : 'Hire AI employee'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/employees')}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
