'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ClientApiError, clientFetch } from '@/lib/client-api';

export function SetupForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await clientFetch('/v1/orgs', {
        method: 'POST',
        body: { name: form.get('name'), domain: form.get('domain') },
      });
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof ClientApiError ? err : null);
      setPending(false);
    }
  }

  const hasFieldErrors = error && Object.keys(error.fieldErrors).length > 0;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && !hasFieldErrors && (
        <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
      )}
      <Field
        id="name"
        label="Company name"
        autoComplete="organization"
        required
        disabled={pending}
        error={error?.fieldErrors.name}
      />
      <Field
        id="domain"
        label="Company domain"
        placeholder="acme.com"
        autoCapitalize="none"
        spellCheck={false}
        required
        disabled={pending}
        hint="The domain of your Google Workspace. You’ll verify it with a DNS record later."
        error={error?.fieldErrors.domain}
      />
      <Button type="submit" className="w-full" loading={pending}>
        {pending ? 'Creating organization' : 'Create organization'}
      </Button>
    </form>
  );
}
