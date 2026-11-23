'use client';

import { AlertTriangle, Check, Circle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { clientFetch } from '@/lib/client-api';
import type { AiState, Employee, EmployeeDetail, OnboardingCheck } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';
import { cn } from '@/lib/utils';

const STAGES = [
  'Profile created',
  'Google account linked',
  'Tools connected',
  'Team, manager and access set',
  'Environment ready',
  'Active',
];

/** How many stages are complete in each state (Identity linking §2). */
const STAGES_DONE: Partial<Record<AiState, number>> = {
  draft: 1,
  external_identity_pending: 1,
  identity_connected: 2,
  integrations_pending: 2,
  permissions_configured: 4,
  environment_ready: 5,
};

export function Onboarding({
  employee,
  onboarding,
  isAdmin,
  domain,
}: {
  employee: Employee;
  onboarding: EmployeeDetail['onboarding'];
  isAdmin: boolean;
  domain: string;
}) {
  const failed = onboarding.state === 'onboarding_failed';
  const done = STAGES_DONE[onboarding.state] ?? 0;
  const canSetEmail =
    isAdmin && (employee.status === 'draft' || employee.status === 'external_identity_pending');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Onboarding</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {failed && (
          <div
            role="alert"
            className="flex gap-3 rounded-md border border-red-600 bg-red-50 px-4 py-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
            <div>
              <p className="font-semibold text-red-600">Onboarding failed</p>
              <p className="mt-0.5 text-gray-600">{employee.last_error ?? 'A step failed.'}</p>
            </div>
          </div>
        )}

        {!failed && (
          <ol className="grid gap-2 sm:grid-cols-6" aria-label="Onboarding progress">
            {STAGES.map((label, i) => {
              const state = i < done ? 'done' : i === done ? 'current' : 'todo';
              return (
                <li key={label} className="flex items-start gap-2 sm:flex-col">
                  <span
                    className={cn(
                      'h-1 w-8 shrink-0 self-center rounded-full sm:w-full',
                      state === 'done' ? 'bg-black' : 'bg-gray-300',
                    )}
                    aria-hidden
                  />
                  <span
                    className={cn(
                      'text-xs',
                      state === 'current' ? 'font-semibold' : 'text-gray-600',
                    )}
                  >
                    {label}
                    <span className="sr-only">
                      {state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {canSetEmail && <CompanyEmailForm employee={employee} domain={domain} />}

        <section aria-labelledby="checklist-heading">
          <h3 id="checklist-heading" className="mb-2 text-sm font-semibold">
            Checklist
          </h3>
          <ul className="divide-y divide-gray-300 rounded-md border border-gray-300 text-sm">
            {onboarding.checks.map((c) => (
              <CheckRow key={c.key} check={c} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-600">
            Google sign-in linking, tool connections and access grants are set up in the next
            updates. Until then those items stay pending.
          </p>
        </section>
      </CardContent>
    </Card>
  );
}

function CheckRow({ check }: { check: OnboardingCheck }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      {check.status === 'passed' ? (
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : check.status === 'failed' ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-gray-600" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', check.status === 'failed' && 'text-red-600')}>
          {check.label}
          {!check.required && <span className="font-normal text-gray-600"> · optional</span>}
        </p>
        <p className="break-words text-gray-600">{check.detail}</p>
      </div>
      <span className={cn('text-xs', check.status === 'failed' ? 'text-red-600' : 'text-gray-600')}>
        {check.status === 'passed' ? 'Done' : check.status === 'failed' ? 'Failed' : 'Pending'}
      </span>
    </li>
  );
}

function CompanyEmailForm({ employee, domain }: { employee: Employee; domain: string }) {
  const router = useRouter();
  const form = useFormErrors();
  const [email, setEmail] = useState(employee.email ?? '');
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(!employee.email);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    form.clear();
    try {
      await clientFetch(`/v1/employees/${employee.id}/company-email`, {
        method: 'PUT',
        body: { email: email.trim() },
      });
      setEditing(false);
      router.refresh();
    } catch (err) {
      form.fail(err);
    } finally {
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-300 px-4 py-3 text-sm">
        <p>
          Company account: <span className="font-medium">{employee.email}</span>
        </p>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-3 rounded-md border border-gray-300 p-4"
      aria-label="Company account"
    >
      {form.alert && (
        <FormAlert
          title={form.alert.title}
          detail={form.alert.detail}
          requestId={form.alert.requestId}
        />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field
          id="company-email"
          type="email"
          label="Google Workspace account"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            form.touch('email');
          }}
          disabled={pending}
          error={form.fieldErrors.email}
          placeholder={`frontend-ai@${domain}`}
          hint={`Create it in your Google Admin console first. Must be on @${domain}.`}
          autoComplete="off"
          className="flex-1"
        />
        <div className="flex gap-2 sm:pt-6">
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {pending ? 'Saving' : 'Save'}
          </Button>
          {employee.email && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setEmail(employee.email ?? '');
                form.clear();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
