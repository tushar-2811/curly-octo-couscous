'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { TextareaField } from '@/components/ui/textarea-field';
import { clientFetch, ClientApiError } from '@/lib/client-api';
import { reportClientEvent } from '@/lib/client-log';
import { useFormErrors } from '@/lib/use-form-errors';

/**
 * Type a message as if someone sent it in Chat, and see what the employee decides.
 * For trying the classifier before Chat and Gmail intake are connected.
 */
export function TestMessage({
  employeeId,
  employeeName,
  people,
  modelReady,
}: {
  employeeId: string;
  employeeName: string;
  people: { id: string; name: string }[];
  modelReady: boolean;
}) {
  const router = useRouter();
  const errors = useFormErrors();
  const [body, setBody] = useState('');
  const [senderId, setSenderId] = useState('');
  const [spaceType, setSpaceType] = useState<'space' | 'direct'>('space');
  const [mention, setMention] = useState(false);
  const [thread, setThread] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setSent(null);
    errors.clear();
    try {
      const result = await clientFetch<{ decision: { action: string } | null; pending: boolean }>(
        `/v1/employees/${employeeId}/inbox/test`,
        {
          method: 'POST',
          body: {
            body,
            sender_id: senderId || null,
            space_type: spaceType,
            mention: spaceType === 'space' && mention,
            thread,
          },
        },
      );
      setSent(result.pending ? 'pending' : 'done');
      setBody('');
      router.refresh();
    } catch (err) {
      if (err instanceof ClientApiError) {
        errors.fail(err);
      } else {
        reportClientEvent({
          level: 'error',
          message: 'test message failed unexpectedly',
          context: { error: String(err) },
        });
        errors.fail(
          new ClientApiError(0, 'unexpected', 'Something went wrong', 'Try again.', '', {}),
        );
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Try a message</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-gray-600">
          Until Google Chat is connected, type a message as if someone sent it to {employeeName}. It
          is classified and decided exactly like a real one, but nothing is sent.
        </p>
        {!modelReady && (
          <div className="mb-4">
            <FormAlert
              title="No language model is set up"
              detail="Add OPENAI_API_KEY to .env and restart. Without it, messages meant for the employee are marked for review."
            />
          </div>
        )}
        <form onSubmit={submit} className="space-y-4" noValidate>
          <TextareaField
            id="body"
            label="Message"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              errors.touch('body');
            }}
            placeholder={`${employeeName}, what's the status of WEB-12?`}
            maxLength={4000}
            error={errors.fieldErrors.body}
            required
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              id="sender_id"
              label="From"
              value={senderId}
              onChange={(e) => {
                setSenderId(e.target.value);
                errors.touch('sender_id');
              }}
              options={[
                { value: '', label: 'You' },
                ...people.map((p) => ({ value: p.id, label: p.name })),
              ]}
              error={errors.fieldErrors.sender_id}
            />
            <SelectField
              id="space_type"
              label="Where"
              value={spaceType}
              onChange={(e) => setSpaceType(e.target.value as 'space' | 'direct')}
              options={[
                { value: 'space', label: 'A shared space' },
                { value: 'direct', label: `Direct message to ${employeeName}` },
              ]}
            />
            <Field
              id="thread"
              label="Thread (optional)"
              value={thread}
              onChange={(e) => {
                setThread(e.target.value);
                errors.touch('thread');
              }}
              placeholder="e.g. release"
              maxLength={80}
              hint="Messages with the same thread are read together."
              error={errors.fieldErrors.thread}
            />
          </div>
          {spaceType === 'space' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mention}
                onChange={(e) => setMention(e.target.checked)}
                className="size-4 accent-black"
              />
              @mention {employeeName}
            </label>
          )}
          {errors.alert && (
            <FormAlert
              title={errors.alert.title}
              detail={errors.alert.detail}
              requestId={errors.alert.requestId}
            />
          )}
          {sent && (
            <p role="status" className="text-sm">
              {sent === 'pending'
                ? 'Received. It is still being processed; refresh in a moment to see the decision.'
                : 'Received. The decision is at the top of the list below.'}
            </p>
          )}
          <Button type="submit" loading={sending} disabled={sending || body.trim() === ''}>
            {sending ? 'Classifying…' : 'Send test message'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
