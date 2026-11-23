'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { clientFetch } from '@/lib/client-api';
import type { Employee } from '@/lib/types';
import { useFormErrors } from '@/lib/use-form-errors';

type Action = 'suspend' | 'resume' | 'terminate';

/** Suspend, resume and terminate. Termination asks for the employee's name to confirm. */
export function Lifecycle({ employee }: { employee: Employee }) {
  const router = useRouter();
  const form = useFormErrors();
  const [running, setRunning] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const canSuspend = employee.status === 'active';
  const canResume = employee.status === 'suspended' && employee.suspension_reason === 'manual';

  async function run(action: Action) {
    setRunning(action);
    form.clear();
    try {
      // An empty JSON body keeps every state-changing call JSON (CSRF guard).
      await clientFetch(`/v1/employees/${employee.id}/${action}`, { method: 'POST', body: {} });
      setConfirming(false);
      router.refresh();
    } catch (err) {
      form.fail(err);
    } finally {
      setRunning(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lifecycle</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {form.error && (
          <FormAlert
            title={form.error.title}
            detail={form.error.detail}
            requestId={form.error.requestId}
          />
        )}

        {(canSuspend || canResume) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              {canSuspend
                ? 'Suspending stops new work. Running tasks pause and continue when you resume.'
                : 'Suspended by an admin. Resume to let it take work again.'}
            </p>
            <Button
              size="sm"
              variant="secondary"
              loading={running === (canSuspend ? 'suspend' : 'resume')}
              disabled={running !== null}
              onClick={() => run(canSuspend ? 'suspend' : 'resume')}
            >
              {canSuspend ? 'Suspend' : 'Resume'}
            </Button>
          </div>
        )}
        {employee.status === 'suspended' && !canResume && (
          <p className="text-sm text-gray-600">
            Suspended automatically ({employee.suspension_reason?.replaceAll('_', ' ')}). It resumes
            once the cause is fixed and re-verified.
          </p>
        )}

        <div className="space-y-3 rounded-md border border-red-600 p-4">
          <div>
            <h3 className="text-sm font-semibold text-red-600">Terminate</h3>
            <p className="mt-1 text-sm text-gray-600">
              Permanently ends this employee. Its access is revoked and it can never work again. Its
              profile and history are kept. This can’t be undone.
            </p>
          </div>
          {confirming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim() === employee.display_name) void run('terminate');
              }}
              className="space-y-3"
            >
              <Field
                id="confirm-terminate"
                label={`Type ${employee.display_name} to confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoFocus
                className="max-w-sm"
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="bg-red-600 hover:bg-black"
                  loading={running === 'terminate'}
                  disabled={typed.trim() !== employee.display_name}
                >
                  {running === 'terminate' ? 'Terminating' : 'Terminate employee'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={running !== null}
                  onClick={() => {
                    setConfirming(false);
                    setTyped('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="border-red-600 text-red-600 hover:bg-red-50"
              onClick={() => setConfirming(true)}
              disabled={running !== null}
            >
              Terminate…
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
