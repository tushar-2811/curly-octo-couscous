'use client';

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ClientApiError, clientFetch } from '@/lib/client-api';

export function OrgNameForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setJustSaved(false);
    try {
      const result = await clientFetch<{ organization: { name: string } }>('/v1/orgs/current', {
        method: 'PATCH',
        body: { name },
      });
      setSaved(result.organization.name);
      setName(result.organization.name);
      setJustSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof ClientApiError ? err : null);
    } finally {
      setPending(false);
    }
  }

  const dirty = name.trim() !== saved;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      {error && !error.fieldErrors.name && (
        <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field
          id="name"
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setJustSaved(false);
          }}
          disabled={pending}
          error={error?.fieldErrors.name}
          className="flex-1"
        />
        <Button type="submit" variant="secondary" loading={pending} disabled={!dirty}>
          {pending ? 'Saving' : 'Save'}
        </Button>
      </div>
      {justSaved && (
        <p role="status" className="flex items-center gap-1.5 text-xs">
          <Check className="size-3.5" aria-hidden /> Saved
        </p>
      )}
    </form>
  );
}
