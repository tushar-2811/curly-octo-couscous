'use client';

import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { clientFetch } from '@/lib/client-api';
import type { AccessDecision, ActionInfo, Resource, ResourceTypeInfo } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';

/** "Can it do X on Y?" — runs the same authorize() check the platform uses. */
export function CheckAccess({
  employeeId,
  resources,
  actions,
  types,
}: {
  employeeId: string;
  resources: Resource[];
  actions: ActionInfo[];
  types: ResourceTypeInfo[];
}) {
  const form = useFormErrors();
  const [pending, setPending] = useState(false);
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const resource = resources.find((r) => r.id === resourceId);
  const available = actions.filter((a) => a.resource_type === resource?.type);
  const [actionKey, setActionKey] = useState(available[0]?.key ?? '');
  const action = available.find((a) => a.key === actionKey) ?? available[0];
  const [branch, setBranch] = useState('');
  const [result, setResult] = useState<{ decision: AccessDecision; asked: string } | null>(null);

  if (resources.length === 0) {
    return null;
  }
  const typeLabel = new Map(types.map((t) => [t.key, t.label]));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resource || !action) return;
    setPending(true);
    form.clear();
    const qs = new URLSearchParams({ action: action.key, resource_id: resource.id });
    if (action.needs_branch && branch.trim()) qs.set('branch', branch.trim());
    try {
      const { decision } = await clientFetch<{ decision: AccessDecision }>(
        `/v1/employees/${employeeId}/authorize?${qs.toString()}`,
      );
      setResult({
        decision,
        asked: `${action.label} on ${resource.name}${action.needs_branch && branch.trim() ? ` (${branch.trim()})` : ''}`,
      });
    } catch (err) {
      setResult(null);
      form.fail(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Check access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          Test a single action against the rules above. This is the same check the employee goes
          through before it touches anything.
        </p>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {form.error && (
            <FormAlert
              title={form.error.title}
              detail={form.error.detail}
              requestId={form.error.requestId}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              id="check-resource"
              label="Resource"
              options={resources.map((r) => ({
                value: r.id,
                label: `${r.name} · ${typeLabel.get(r.type) ?? r.type}`,
              }))}
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                const next = resources.find((r) => r.id === e.target.value);
                setActionKey(actions.find((a) => a.resource_type === next?.type)?.key ?? '');
                setResult(null);
              }}
              disabled={pending}
            />
            <SelectField
              id="check-action"
              label="Action"
              options={available.map((a) => ({ value: a.key, label: a.label }))}
              value={action?.key ?? ''}
              onChange={(e) => {
                setActionKey(e.target.value);
                setResult(null);
              }}
              disabled={pending}
            />
            {action?.needs_branch && (
              <Field
                id="check-branch"
                label="Branch"
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setResult(null);
                }}
                placeholder="ai/PF-3106-card"
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
            )}
          </div>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {pending ? 'Checking' : 'Check'}
          </Button>
        </form>

        {result && (
          <div
            role="status"
            aria-live="polite"
            className={
              result.decision.allowed
                ? 'rounded-md border border-black p-3 text-sm'
                : 'rounded-md border border-red-600 bg-red-50 p-3 text-sm'
            }
          >
            <div className="flex items-center gap-2">
              <Badge variant={result.decision.allowed ? 'solid' : 'danger'}>
                {result.decision.allowed ? 'Allowed' : 'Denied'}
              </Badge>
              <span className="font-medium">{result.asked}</span>
            </div>
            {!result.decision.allowed && (
              <p className="mt-1 text-red-600">{result.decision.message}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
