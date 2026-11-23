'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { ClientApiError, clientFetch } from '@/lib/client-api';
import { unitOptions } from '@/lib/org';
import { UNIT_KIND_LABELS, type OrgUnit, type OrgUnitKind } from '@/lib/types';

const KIND_OPTIONS = (Object.keys(UNIT_KIND_LABELS) as OrgUnitKind[]).map((k) => ({
  value: k,
  label: UNIT_KIND_LABELS[k],
}));

/** Create a unit (under `parentId`) or edit one: name, kind and, when editing, its parent. */
export function UnitForm({
  units,
  unit,
  parentId = null,
  onDone,
}: {
  units: OrgUnit[];
  unit?: OrgUnit;
  parentId?: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const editing = Boolean(unit);
  const [name, setName] = useState(unit?.name ?? '');
  const [kind, setKind] = useState<OrgUnitKind>(unit?.kind ?? (parentId ? 'team' : 'department'));
  const [parent, setParent] = useState(unit?.parent_id ?? parentId ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  // Fields edited since the last failed submit; their old error is no longer shown.
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setEdited((s) => new Set(s).add(key));
  const prefix = unit ? `unit-${unit.id}` : `new-unit-${parentId ?? 'root'}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (unit) {
        await clientFetch(`/v1/org-units/${unit.id}`, {
          method: 'PATCH',
          body: { name, kind, parent_id: parent || null },
        });
      } else {
        await clientFetch('/v1/org-units', {
          method: 'POST',
          body: { name, kind, parent_id: parentId },
        });
      }
      router.refresh();
      onDone();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setEdited(new Set());
    } finally {
      setPending(false);
    }
  }

  const allFieldErrors = error?.fieldErrors ?? {};
  const fieldErrors = Object.fromEntries(
    Object.entries(allFieldErrors).filter(([k]) => !edited.has(k)),
  ) as Record<string, string>;
  const showAlert = error && Object.keys(allFieldErrors).length === 0;
  // A unit can't be moved under itself; the API also refuses moves under its descendants.
  const parentOptions = unitOptions(
    units.filter((u) => u.id !== unit?.id),
    'None (top level)',
  );

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label={editing ? `Edit ${unit?.name}` : 'Add a department or team'}
      className="space-y-4 rounded-md border border-black bg-white p-4"
    >
      {showAlert && (
        <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${prefix}-name`}
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            touch('name');
          }}
          disabled={pending}
          error={fieldErrors.name}
          autoFocus
          required
          maxLength={120}
        />
        <SelectField
          id={`${prefix}-kind`}
          label="Type"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as OrgUnitKind);
            touch('kind');
          }}
          disabled={pending}
          error={fieldErrors.kind}
        />
        {editing && (
          <SelectField
            id={`${prefix}-parent`}
            label="Part of"
            options={parentOptions}
            value={parent}
            onChange={(e) => {
              setParent(e.target.value);
              touch('parent_id');
            }}
            disabled={pending}
            error={fieldErrors.parent_id}
            className="sm:col-span-2"
          />
        )}
      </div>
      {!editing && fieldErrors.parent_id && (
        <p role="alert" className="text-xs font-semibold text-red-600">
          Error: {fieldErrors.parent_id}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {pending ? 'Saving' : editing ? 'Save' : 'Add'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
