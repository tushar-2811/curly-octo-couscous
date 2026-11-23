'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ClientApiError, clientFetch } from '@/lib/client-api';

/** Email-only sign-in for local development (the API refuses it outside local). */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const result = await clientFetch<{ has_organization: boolean }>('/v1/auth/dev-login', {
        method: 'POST',
        body: { email: form.get('email'), name: form.get('name') },
      });
      router.replace(result.has_organization ? next : '/setup');
      router.refresh();
    } catch (err) {
      setError(err instanceof ClientApiError ? err : null);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 border-t border-gray-300 pt-6">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">
        Development sign-in
      </p>
      {error && Object.keys(error.fieldErrors).length === 0 && (
        <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
      )}
      <Field
        id="email"
        label="Work email"
        type="email"
        autoComplete="email"
        required
        disabled={pending}
        error={error?.fieldErrors.email}
      />
      <Field
        id="name"
        label="Your name"
        autoComplete="name"
        required
        disabled={pending}
        error={error?.fieldErrors.name}
      />
      <Button type="submit" className="w-full" loading={pending}>
        {pending ? 'Signing in' : 'Sign in'}
      </Button>
    </form>
  );
}
