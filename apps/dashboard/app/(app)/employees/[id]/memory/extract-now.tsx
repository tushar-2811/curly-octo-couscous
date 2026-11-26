'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { clientFetch, ClientApiError } from '@/lib/client-api';
import { reportClientEvent } from '@/lib/client-log';

interface ExtractResult {
  conversations: number;
  remaining: number;
  messages_read: number;
  facts_added: number;
  facts_superseded: number;
  failed: number;
}

/** Read pending conversations now instead of waiting for them to go quiet (local and dev). */
export function ExtractNow({ employeeId, pending }: { employeeId: string; pending: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await clientFetch<ExtractResult>(`/v1/employees/${employeeId}/memory/extract`, {
          method: 'POST',
        }),
      );
      router.refresh();
    } catch (err) {
      if (err instanceof ClientApiError) {
        setError(err);
      } else {
        reportClientEvent({
          level: 'error',
          message: 'extract now failed unexpectedly',
          context: { error: String(err) },
        });
        setError(new ClientApiError(0, 'unexpected', 'Something went wrong', 'Try again.', '', {}));
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={run}
          loading={running}
          disabled={running || pending === 0}
          variant="secondary"
        >
          {running ? 'Reading conversations…' : 'Extract now'}
        </Button>
        <span className="text-sm text-gray-600">
          {pending === 0
            ? 'Every conversation has been read.'
            : `${pending} ${pending === 1 ? 'conversation has' : 'conversations have'} new messages.`}
        </span>
      </div>
      {error && <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />}
      {result && (
        <p role="status" className="text-sm">
          Read {result.messages_read} {result.messages_read === 1 ? 'message' : 'messages'} in{' '}
          {result.conversations} {result.conversations === 1 ? 'conversation' : 'conversations'}:{' '}
          {result.facts_added} new {result.facts_added === 1 ? 'fact' : 'facts'}
          {result.facts_superseded > 0 ? `, ${result.facts_superseded} replaced` : ''}.
          {result.remaining > 0 ? ` ${result.remaining} more to read; run it again.` : ''}
        </p>
      )}
      {result && result.failed > 0 && (
        <p role="alert" className="text-sm font-semibold text-red-600">
          Error: {result.failed} {result.failed === 1 ? 'conversation' : 'conversations'} could not
          be read (model error). They will be tried again.
        </p>
      )}
    </div>
  );
}
