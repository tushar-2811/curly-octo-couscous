import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RetryButton } from '@/components/retry-button';
import { ErrorState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import type { Me } from '@/lib/types';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up your organization' };
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  let me: Me;
  try {
    me = await getMe();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return (
      <ErrorState
        title={err.title}
        description={err.detail}
        requestId={err.requestId}
        action={<RetryButton />}
      />
    );
  }
  if (me.organization) redirect('/');

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Set up your organization</h1>
      <p className="mt-1 text-sm text-gray-600">
        Signed in as {me.user.email}. You’ll be the first admin.
      </p>
      <div className="mt-8">
        <SetupForm />
      </div>
    </>
  );
}
