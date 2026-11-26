import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { RetryButton } from '@/components/retry-button';
import { ErrorState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import type { Me } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Signed-in area: requires a session and an organization; otherwise redirects. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  let me: Me;
  try {
    me = await getMe();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return (
      <main className="mx-auto max-w-lg px-4 py-24">
        <ErrorState
          title={err.title}
          description={err.detail ?? 'Your account could not be loaded.'}
          requestId={err.requestId}
          action={<RetryButton />}
        />
      </main>
    );
  }
  if (!me.organization || !me.member) redirect('/setup');

  return (
    <AppShell
      orgName={me.organization.name}
      user={{ name: me.member.display_name, email: me.user.email }}
      canAudit={me.member.role === 'admin' || me.member.role === 'security_admin'}
    >
      {children}
    </AppShell>
  );
}
