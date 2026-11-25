'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { clientFetch } from '@/lib/client-api';
import type { Resource, ResourceType, ResourceTypeInfo } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';
import { splitList } from '@/lib/utils';

/** "Add resource" button that opens the form in place. */
export function AddResource({
  types,
  defaultType,
}: {
  types: ResourceTypeInfo[];
  defaultType: ResourceType | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="mb-6">
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden />
          Add resource
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Add resource</CardTitle>
      </CardHeader>
      <CardContent>
        <ResourceForm types={types} defaultType={defaultType} onDone={() => setOpen(false)} />
      </CardContent>
    </Card>
  );
}

/** Add a resource, or edit one (`resource` set: the type and id can't change). */
export function ResourceForm({
  types,
  defaultType,
  resource,
  onDone,
}: {
  types: ResourceTypeInfo[];
  defaultType?: ResourceType | undefined;
  resource?: Resource;
  onDone: () => void;
}) {
  const router = useRouter();
  const form = useFormErrors();
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState({
    type: resource?.type ?? defaultType ?? types[0]?.key ?? 'repo',
    external_id: resource?.external_id ?? '',
    name: resource?.name ?? '',
    url: resource?.url ?? '',
    tags: resource?.tags.join(', ') ?? '',
  });
  const info = types.find((t) => t.key === values.type);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    form.touch(key);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    form.clear();
    const common = {
      name: values.name,
      url: values.url.trim() || null,
      tags: splitList(values.tags),
    };
    try {
      if (resource) {
        await clientFetch(`/v1/resources/${resource.id}`, { method: 'PATCH', body: common });
      } else {
        await clientFetch('/v1/resources', {
          method: 'POST',
          body: { ...common, type: values.type, external_id: values.external_id },
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
  const id = (k: string) => `${resource?.id ?? 'new'}-${k}`;
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
        {!resource && (
          <>
            <SelectField
              id={id('type')}
              label="Type"
              options={types.map((t) => ({ value: t.key, label: t.label }))}
              value={values.type}
              onChange={set('type')}
              disabled={pending}
              error={fe.type}
            />
            <Field
              id={id('external_id')}
              label={values.type === 'jira_project' ? 'Project key' : 'Id'}
              value={values.external_id}
              onChange={set('external_id')}
              disabled={pending}
              error={fe.external_id}
              placeholder={info?.external_id.example}
              hint={info?.external_id.hint}
              autoComplete="off"
              spellCheck={false}
            />
          </>
        )}
        <Field
          id={id('name')}
          label="Name"
          value={values.name}
          onChange={set('name')}
          disabled={pending}
          error={fe.name}
          hint="Optional. Defaults to the id."
          maxLength={120}
        />
        <Field
          id={id('url')}
          label="Link"
          type="url"
          value={values.url}
          onChange={set('url')}
          disabled={pending}
          error={fe.url}
          placeholder="https://"
          hint="Optional."
        />
        <Field
          id={id('tags')}
          label="Tags"
          value={values.tags}
          onChange={set('tags')}
          disabled={pending}
          error={fe.tags}
          placeholder="frontend, web"
          hint="Optional, separated by commas. A grant can cover every item with a tag."
          autoComplete="off"
          className="sm:col-span-2"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {resource ? (pending ? 'Saving' : 'Save') : pending ? 'Adding' : 'Add resource'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
