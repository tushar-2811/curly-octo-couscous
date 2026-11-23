import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RetryButton } from '@/components/retry-button';
import { ErrorState } from '@/components/ui/states';
import { apiFetch } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import type { Me } from '@/lib/types';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/** Only allow same-site relative paths as the post-sign-in destination. */
function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);

  let methods: { dev_login: boolean; google: boolean };
  try {
    methods = await apiFetch('/v1/auth/methods');
    // Already signed in? Skip the form.
    const me = await apiFetch<Me>('/v1/me').catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    });
    if (me) redirect(me.organization ? next : '/setup');
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return (
      <ErrorState
        title={err.title}
        description={err.detail ?? 'Sign-in is unavailable right now.'}
        requestId={err.requestId}
        action={<RetryButton />}
      />
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-gray-600">Manage your organization’s AI employees.</p>
      <div className="mt-8 space-y-6">
        <button
          type="button"
          disabled
          className="flex h-9 w-full items-center justify-center rounded-md border border-gray-300 text-sm text-gray-600"
          title="Google sign-in needs a Google OAuth client"
        >
          Continue with Google
        </button>
        {!methods.google && (
          <p className="-mt-3 text-xs text-gray-600">Google sign-in is not configured yet.</p>
        )}
        {methods.dev_login ? (
          <SignInForm next={next} />
        ) : (
          <p className="text-sm text-gray-600">
            No sign-in method is available. Contact your administrator.
          </p>
        )}
      </div>
    </>
  );
}
