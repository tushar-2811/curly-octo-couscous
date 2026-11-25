'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { clientFetch } from '@/lib/client-api';
import type { Grant, GrantLevel, Resource, ResourceType, ResourceTypeInfo } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';
import { cn, splitList } from '@/lib/utils';

/**
 * Add an access rule, or edit one (`grant` set: its target can't change). A rule allows
 * or blocks one resource, or every resource of a type (optionally only tagged ones).
 */
export function GrantForm({
  employeeId,
  types,
  resources,
  grant,
  onDone,
}: {
  employeeId: string;
  types: ResourceTypeInfo[];
  resources: Resource[];
  grant?: Grant;
  onDone: () => void;
}) {
  const router = useRouter();
  const form = useFormErrors();
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState({
    resource_type: grant?.resource_type ?? types[0]?.key ?? 'repo',
    resource_id: grant?.resource?.id ?? '',
    effect: grant?.effect ?? 'allow',
    level: grant?.level ?? 'read',
    tags: grant?.tags.join(', ') ?? '',
    branches: grant?.branches.join(', ') ?? '',
  });
  const info = types.find((t) => t.key === values.resource_type);
  const levels = info?.levels ?? [];
  const everyItem = values.resource_id === '';
  const showBranches =
    values.resource_type === 'repo' && values.effect === 'allow' && values.level === 'write';

  const update = (patch: Partial<typeof values>) => {
    setValues((v) => {
      const next = { ...v, ...patch };
      // Keep the level valid for the chosen type.
      const allowed = types.find((t) => t.key === next.resource_type)?.levels ?? [];
      if (!allowed.some((l) => l.key === next.level)) next.level = allowed[0]?.key ?? 'read';
      return next;
    });
    for (const key of Object.keys(patch)) form.touch(key);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    form.clear();
    const conditions = {
      tags: everyItem ? splitList(values.tags) : [],
      branches: showBranches ? splitList(values.branches) : [],
    };
    try {
      if (grant) {
        await clientFetch(`/v1/employees/${employeeId}/grants/${grant.id}`, {
          method: 'PATCH',
          body: { effect: values.effect, level: values.level, ...conditions },
        });
      } else {
        await clientFetch(`/v1/employees/${employeeId}/grants`, {
          method: 'POST',
          body: {
            resource_type: values.resource_type,
            resource_id: values.resource_id || null,
            effect: values.effect,
            level: values.level,
            ...conditions,
          },
        });
      }
      onDone();
      router.refresh();
    } catch (err) {
      form.fail(err);
    } finally {
      setPending(false);
    }
  }

  const fe = form.fieldErrors;
  const id = (k: string) => `${grant?.id ?? 'new'}-${k}`;
  const ofType = resources.filter((r) => r.type === values.resource_type);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {form.alert && (
        <FormAlert
          title={form.alert.title}
          detail={form.alert.detail}
          requestId={form.alert.requestId}
        />
      )}

      {!grant && (
        <div className="grid gap-5 sm:grid-cols-2">
          <SelectField
            id={id('resource_type')}
            label="Type"
            options={types.map((t) => ({ value: t.key, label: t.label }))}
            value={values.resource_type}
            onChange={(e) =>
              update({ resource_type: e.target.value as ResourceType, resource_id: '' })
            }
            disabled={pending}
            error={fe.resource_type}
          />
          <SelectField
            id={id('resource_id')}
            label="Applies to"
            options={[
              { value: '', label: `Every ${info?.noun ?? 'item'}` },
              ...ofType.map((r) => ({ value: r.id, label: `${r.name} (${r.external_id})` })),
            ]}
            value={values.resource_id}
            onChange={(e) => update({ resource_id: e.target.value })}
            disabled={pending}
            error={fe.resource_id}
            hint={
              ofType.length === 0
                ? `No ${info?.nouns ?? 'items'} on the Access page yet.`
                : undefined
            }
          />
        </div>
      )}

      {everyItem && (
        <Field
          id={id('tags')}
          label="Only items tagged"
          value={values.tags}
          onChange={(e) => update({ tags: e.target.value })}
          disabled={pending}
          error={fe.tags}
          placeholder="frontend"
          hint={`Optional, separated by commas. Leave empty for every ${info?.noun ?? 'item'}, including ones added later.`}
          autoComplete="off"
          className="max-w-md"
        />
      )}

      <Choice
        legend="Rule"
        name={id('effect')}
        value={values.effect}
        disabled={pending}
        error={fe.effect}
        onChange={(v) => update({ effect: v as 'allow' | 'deny' })}
        options={[
          { value: 'allow', label: 'Allow', help: 'Give this access' },
          {
            value: 'deny',
            label: 'Block',
            help: 'Overrides any allow rule, for example to exclude one repository',
          },
        ]}
      />

      <Choice
        legend={values.effect === 'deny' ? 'Block from' : 'Access'}
        name={id('level')}
        value={values.level}
        disabled={pending}
        error={fe.level}
        onChange={(v) => update({ level: v as GrantLevel })}
        options={levels.map((l) => ({
          value: l.key,
          label:
            values.effect === 'deny'
              ? l.key === 'read'
                ? 'All access'
                : 'Writing (reading stays allowed)'
              : l.key === 'read'
                ? 'Read'
                : 'Read and write',
          help: l.help,
        }))}
      />

      {showBranches && (
        <Field
          id={id('branches')}
          label="Branches it may push to"
          value={values.branches}
          onChange={(e) => update({ branches: e.target.value })}
          disabled={pending}
          error={fe.branches}
          placeholder="ai/*, feature/*"
          hint="Optional, separated by commas. * matches anything. Leave empty for any branch. It never merges its own pull requests."
          autoComplete="off"
          spellCheck={false}
          className="max-w-md"
        />
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {grant ? (pending ? 'Saving' : 'Save rule') : pending ? 'Adding' : 'Add rule'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Choice({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
  error,
}: {
  legend: string;
  name: string;
  value: string;
  options: { value: string; label: string; help: string }[];
  onChange: (value: string) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  return (
    <fieldset aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer gap-2 rounded-md border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-black',
                selected ? 'border-2 border-black' : 'border-gray-300 hover:border-black',
                error && !selected && 'border-red-600',
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={selected}
                onChange={() => onChange(o.value)}
                disabled={disabled}
                className="mt-0.5 accent-black"
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-gray-600">{o.help}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={`${name}-error`} role="alert" className="mt-2 text-xs font-semibold text-red-600">
          Error: {error}
        </p>
      )}
    </fieldset>
  );
}
