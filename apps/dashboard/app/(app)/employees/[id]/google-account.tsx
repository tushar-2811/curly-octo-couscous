'use client';

import { AlertTriangle, Check, ExternalLink, RotateCw, Unlink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { clientFetch, ClientApiError } from '@/lib/client-api';
import { linkErrorMessage } from '@/lib/link-errors';
import type { ChatStatus, Employee, ExternalIdentity } from '@/lib/types';
import { formatDate, formatDateTime } from '@/lib/utils';

export interface LinkResult {
  status: 'connected' | 'error';
  code?: string;
  requestId?: string;
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Sign-in',
  email: 'Email address',
  profile: 'Name and photo',
  'https://www.googleapis.com/auth/userinfo.email': 'Email address',
  'https://www.googleapis.com/auth/userinfo.profile': 'Name and photo',
  'https://www.googleapis.com/auth/chat.messages.readonly': 'Read Chat messages',
  'https://www.googleapis.com/auth/chat.messages.create': 'Post Chat messages',
  'https://www.googleapis.com/auth/chat.spaces.readonly': 'See Chat spaces',
  'https://www.googleapis.com/auth/directory.readonly': 'Company directory',
  'https://www.googleapis.com/auth/pubsub': 'Chat event queue',
};

const CHAT_READ = 'https://www.googleapis.com/auth/chat.messages.readonly';

/**
 * The employee's company Google account (Identity linking flow B and D): link it by
 * signing in as it, see what was granted, disconnect it.
 */
export function GoogleAccount({
  employee,
  identities,
  googleConfigured,
  chat,
  isAdmin,
  result,
}: {
  employee: Employee;
  identities: ExternalIdentity[];
  googleConfigured: boolean;
  chat: ChatStatus | null;
  isAdmin: boolean;
  result: LinkResult | null;
}) {
  const connected = identities.find(
    (i) => i.connection_status === 'connected' || i.connection_status === 'reauth_required',
  );
  const past = identities.filter((i) => i !== connected);

  // Show the result once: drop ?link… from the address so a reload doesn't repeat it.
  useEffect(() => {
    if (!result) return;
    const url = new URL(window.location.href);
    for (const key of ['link', 'link_error', 'request_id']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.toString());
  }, [result]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {result?.status === 'connected' && connected && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-md border border-black px-4 py-3 text-sm"
          >
            <Check className="size-4 shrink-0" aria-hidden />
            Linked {connected.email}. Onboarding moves on to connecting its tools.
          </p>
        )}
        {result?.status === 'error' && result.code && (
          <FormAlert
            {...linkErrorMessage(result.code, employee.email)}
            requestId={result.requestId}
          />
        )}

        {connected ? (
          <Linked employee={employee} identity={connected} isAdmin={isAdmin} chat={chat} />
        ) : (
          <NotLinked
            employee={employee}
            googleConfigured={googleConfigured}
            isAdmin={isAdmin}
            chatConfigured={chat?.configured ?? false}
          />
        )}

        {past.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-600 hover:text-black">
              Previously linked ({past.length})
            </summary>
            <ul className="mt-2 divide-y divide-gray-300 rounded-md border border-gray-300">
              {past.map((i) => (
                <li key={i.id} className="px-3 py-2 text-gray-600">
                  <span className="font-medium text-black">{i.email}</span> · linked{' '}
                  {formatDate(i.connected_at)}
                  {i.disconnected_at && ` · disconnected ${formatDate(i.disconnected_at)}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function NotLinked({
  employee,
  googleConfigured,
  isAdmin,
  chatConfigured,
}: {
  employee: Employee;
  googleConfigured: boolean;
  isAdmin: boolean;
  chatConfigured: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  if (employee.status === 'terminated') {
    return <p className="text-sm text-gray-600">No account is linked.</p>;
  }
  if (!employee.email) {
    return (
      <p className="text-sm text-gray-600">
        Enter the company Google account in Onboarding first. Your IT team creates it in the Google
        Admin console.
      </p>
    );
  }
  if (!googleConfigured) {
    return (
      <FormAlert
        title="Google sign-in isn’t set up on the server"
        detail="Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY to the API’s settings and restart it."
      />
    );
  }
  if (!isAdmin) {
    return (
      <p className="text-sm text-gray-600">
        Not linked yet. An admin links {employee.email} by signing in to it.
      </p>
    );
  }

  async function start() {
    setPending(true);
    setError(null);
    try {
      const res = await clientFetch<{ authorization_url: string }>(
        `/v1/employees/${employee.id}/identities/link-start`,
        { method: 'POST' },
      );
      // Leave for Google; the button stays busy until the page unloads.
      window.location.assign(res.authorization_url);
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {error && <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />}
      <p>
        Google will ask you to sign in. Choose <span className="font-medium">{employee.email}</span>
        , not your own account, and allow the permissions it lists: sign-in, email address, name and
        photo{chatConfigured ? ', and reading and posting its Google Chat messages' : ''}.
      </p>
      <Button onClick={() => void start()} loading={pending}>
        <ExternalLink className="size-4" aria-hidden />
        {pending ? 'Opening Google' : 'Link Google account'}
      </Button>
    </div>
  );
}

function Linked({
  employee,
  identity,
  isAdmin,
  chat,
}: {
  employee: Employee;
  identity: ExternalIdentity;
  isAdmin: boolean;
  chat: ChatStatus | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'disconnect' | 'retry' | null>(null);
  const [error, setError] = useState<ClientApiError | null>(null);
  const scopes = [...new Set(identity.granted_scopes.map((s) => SCOPE_LABELS[s] ?? s))];
  const stuck = employee.status === 'identity_connected';

  async function act(kind: 'disconnect' | 'retry') {
    setPending(kind);
    setError(null);
    try {
      await clientFetch(
        kind === 'disconnect'
          ? `/v1/employees/${employee.id}/identities/${identity.id}/disconnect`
          : `/v1/employees/${employee.id}/onboarding/continue`,
        { method: 'POST' },
      );
      setConfirming(false);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-gray-300 px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{identity.email}</span>
            {identity.connection_status === 'connected' ? (
              <Badge>Connected</Badge>
            ) : (
              <Badge variant="danger">Needs sign-in again</Badge>
            )}
          </p>
          <p className="mt-0.5 text-gray-600">
            Linked {formatDate(identity.connected_at)}
            {identity.hosted_domain && ` · Workspace ${identity.hosted_domain}`}
          </p>
          <p className="mt-0.5 text-gray-600">Allowed: {scopes.join(', ') || 'nothing'}</p>
        </div>
        {isAdmin && employee.status !== 'terminated' && !confirming && (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            <Unlink className="size-4" aria-hidden />
            Disconnect
          </Button>
        )}
      </div>

      {chat?.configured && (
        <ChatLine chat={chat} granted={identity.granted_scopes.includes(CHAT_READ)} />
      )}

      {stuck && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-300 px-4 py-3">
          <p className="text-gray-600">
            Moving on to connecting its tools. If this doesn’t change after a few seconds, the
            background worker may be down.
          </p>
          {isAdmin && (
            <Button
              size="sm"
              variant="secondary"
              loading={pending === 'retry'}
              onClick={() => void act('retry')}
            >
              <RotateCw className="size-4" aria-hidden />
              {pending === 'retry' ? 'Retrying' : 'Retry'}
            </Button>
          )}
        </div>
      )}

      {error && <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />}

      {confirming && (
        <div className="space-y-3 rounded-md border border-red-600 bg-red-50 p-3" role="alert">
          <p className="flex gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
            <span>
              <span className="font-semibold text-red-600">Disconnect {identity.email}?</span>{' '}
              {employee.status === 'active'
                ? 'The employee is suspended and its work pauses until an account is linked again.'
                : 'Onboarding goes back to waiting for a Google account.'}{' '}
              We revoke our access at Google. The Google account itself, and the employee’s profile
              and history, are not deleted.
            </span>
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-red-600 hover:bg-black"
              loading={pending === 'disconnect'}
              onClick={() => void act('disconnect')}
            >
              {pending === 'disconnect' ? 'Disconnecting' : 'Disconnect'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether the employee is listening to Google Chat, and since when. */
function ChatLine({ chat, granted }: { chat: ChatStatus; granted: boolean }) {
  const sub = chat.subscription;
  if (!granted) {
    return (
      <p role="alert" className="text-sm font-semibold text-red-600">
        Error: Chat access wasn’t granted. Disconnect and link the account again to allow it.
      </p>
    );
  }
  if (sub?.last_error) {
    return (
      <p role="alert" className="text-sm font-semibold text-red-600 [overflow-wrap:anywhere]">
        Error: Google Chat isn’t connected: {sub.last_error}
      </p>
    );
  }
  if (!sub) {
    return (
      <p className="text-sm text-gray-600">
        Google Chat: connecting… The worker sets this up within a minute.
      </p>
    );
  }
  return (
    <p className="text-sm text-gray-600">
      Google Chat: {sub.state === 'active' ? 'listening in all its spaces' : 'paused by Google'}
      {sub.last_event_at ? ` · last message ${formatDateTime(sub.last_event_at)}` : ''}
      {sub.expire_time ? ` · renews before ${formatDateTime(sub.expire_time)}` : ''}
    </p>
  );
}
