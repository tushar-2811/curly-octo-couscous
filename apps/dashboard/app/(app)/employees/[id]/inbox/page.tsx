import { ExternalLink, Inbox as InboxIcon, Lock } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { apiFetch, getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { getInbox, type InboxEntry, type InboxPage, type InboxReply } from '@/lib/inbox';
import { listPeople } from '@/lib/structure';
import type { EmployeeDetail, MemberRow } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';
import {
  ACTION_LABELS,
  ADDRESSED_LABELS,
  ERROR_LABELS,
  FACT_LABELS,
  INTENT_LABELS,
  NEED_LABELS,
} from './labels';
import { TestMessage } from './test-message';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { id } = await params;
  const { cursor } = await searchParams;
  if (!UUID.test(id)) notFound();
  const validCursor = cursor && UUID.test(cursor) ? cursor : undefined;

  const me = await getMe();
  const role = me.member?.role;
  if (role !== 'admin' && role !== 'security_admin') {
    return (
      <>
        <BackLink id={id} />
        <EmptyState
          icon={Lock}
          title="Only admins can read an AI employee’s messages"
          description="Ask an admin or security admin of your organization."
        />
      </>
    );
  }

  let detail: EmployeeDetail;
  let page: InboxPage;
  let people: MemberRow[];
  try {
    [detail, page, people] = await Promise.all([
      apiFetch<EmployeeDetail>(`/v1/employees/${id}`),
      getInbox(id, validCursor),
      listPeople({ status: 'active' }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <BackLink id={id} />
        <LoadError error={err} what="the inbox" />
      </>
    );
  }
  const { employee } = detail;

  return (
    <>
      <BackLink id={id} />
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">{employee.display_name}’s inbox</h1>
        <p className="mt-1 text-sm text-gray-600">
          Messages it received and what it decided to do with each.{' '}
          {page.classifier
            ? `Classified and answered by ${page.classifier.model}.`
            : 'No language model is set up yet.'}{' '}
          {page.embeddings
            ? `Memory searched by meaning (${page.embeddings.model}) and by words.`
            : 'Memory searched by words only (no VOYAGE_API_KEY).'}{' '}
          {page.jira ? `Reads Jira at ${page.jira.site}.` : 'Jira is not connected.'}
        </p>
      </div>

      <div className="grid gap-6">
        {page.test_messages && !validCursor && employee.status !== 'terminated' && (
          <TestMessage
            employeeId={employee.id}
            employeeName={employee.display_name}
            people={people
              .filter((p) => p.type === 'human' && p.id !== me.member?.id)
              .map((p) => ({ id: p.id, name: p.display_name }))}
            modelReady={page.classifier !== null}
          />
        )}

        {page.entries.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title={validCursor ? 'No older messages' : 'No messages yet'}
            description={
              validCursor
                ? undefined
                : 'Messages from Google Chat will appear here once it is connected.'
            }
          />
        ) : (
          <section aria-label="Messages">
            <ul className="divide-y divide-gray-300 border-y border-gray-300">
              {page.entries.map((entry) => (
                <Entry key={entry.message.id} entry={entry} employeeName={employee.display_name} />
              ))}
            </ul>
            <nav className="mt-4 flex justify-between text-sm" aria-label="Pages">
              {validCursor ? (
                <Link
                  href={`/employees/${id}/inbox`}
                  className="rounded-md border border-black px-3 py-1.5 font-medium hover:bg-gray-100"
                >
                  ← Newest
                </Link>
              ) : (
                <span />
              )}
              {page.next_cursor && (
                <Link
                  href={`/employees/${id}/inbox?cursor=${page.next_cursor}`}
                  className="rounded-md border border-black px-3 py-1.5 font-medium hover:bg-gray-100"
                >
                  Older messages →
                </Link>
              )}
            </nav>
          </section>
        )}
      </div>
    </>
  );
}

function Entry({ entry, employeeName }: { entry: InboxEntry; employeeName: string }) {
  const { message: m, decision: d } = entry;
  const c = d?.classification ?? null;
  const failed = m.status === 'failed' || d?.action === 'needs_review' || d?.error_code;
  const where =
    m.space_type === 'direct'
      ? 'Direct message'
      : m.space_type === 'email'
        ? 'Email'
        : (m.space_name ?? 'Space');
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{m.sender.name ?? m.sender.email ?? 'Unknown sender'}</span>
        <span className="text-gray-600">
          · {where}
          {m.thread_key ? ` · thread ${m.thread_key.replace(/^test:/, '')}` : ''}
          {m.source === 'simulated' ? ' · test' : ''}
        </span>
        <time dateTime={m.received_at} className="ml-auto text-xs text-gray-600">
          {formatDateTime(m.received_at)}
        </time>
      </div>
      {m.subject && <p className="mt-1 text-sm font-medium">{m.subject}</p>}
      <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
        {m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {d ? (
          <Badge
            variant={
              d.action === 'needs_review' || d.action === 'decline'
                ? 'danger'
                : d.action === 'reply' || d.action === 'acknowledge'
                  ? 'solid'
                  : 'muted'
            }
          >
            {ACTION_LABELS[d.action]}
          </Badge>
        ) : (
          <Badge variant={m.status === 'failed' ? 'danger' : 'muted'}>
            {m.status === 'failed' ? 'Failed' : 'Not decided yet'}
          </Badge>
        )}
        {c && <Badge>{INTENT_LABELS[c.intent] ?? c.intent}</Badge>}
        {c && (
          <Badge variant="muted">{ADDRESSED_LABELS[c.addressed_to_me] ?? c.addressed_to_me}</Badge>
        )}
        {d?.needs.map((n) => (
          <Badge key={n} variant="muted">
            Needs {NEED_LABELS[n] ?? n}
          </Badge>
        ))}
        {d && <span className="text-xs text-gray-600">{d.reasons[0]}</span>}
      </div>

      {failed && (d?.error_code || m.last_error) && (
        <p role="alert" className="mt-2 text-xs font-semibold text-red-600">
          Error: {d?.error_code ? (ERROR_LABELS[d.error_code] ?? d.error_code) : m.last_error}
        </p>
      )}

      {entry.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-black pl-3">
          {entry.replies.map((r) => (
            <Reply key={r.id} reply={r} name={employeeName} />
          ))}
        </div>
      )}

      {d && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-gray-600 hover:text-black">Why</summary>
          <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md bg-gray-100 p-3 text-xs sm:grid-cols-[12rem_1fr]">
            {c && (
              <>
                <dt className="text-gray-600">Summary</dt>
                <dd>{c.summary}</dd>
                <dt className="text-gray-600">Model’s reason</dt>
                <dd>{c.reason}</dd>
                <dt className="text-gray-600">Confidence</dt>
                <dd className={c.confidence < 0.6 ? 'font-semibold text-red-600' : undefined}>
                  {Math.round(c.confidence * 100)}%{c.confidence < 0.6 ? ' (low)' : ''}
                </dd>
                <dt className="text-gray-600">Reply expected</dt>
                <dd>
                  {c.should_respond ? 'Yes' : 'No'} · urgency {c.urgency}
                </dd>
                {[...c.references.jira_keys, ...c.references.repos, ...c.references.people].length >
                  0 && (
                  <>
                    <dt className="text-gray-600">Mentions</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {[
                        ...c.references.jira_keys,
                        ...c.references.repos,
                        ...c.references.people,
                      ].join(', ')}
                    </dd>
                  </>
                )}
              </>
            )}
            <dt className="text-gray-600">Decision</dt>
            <dd>{d.reasons.join(' · ')}</dd>
            <dt className="text-gray-600">Facts</dt>
            <dd>
              {Object.entries(d.facts)
                .filter(([, v]) => v === true || (typeof v === 'string' && v !== 'not_listed'))
                .map(([k, v]) =>
                  v === true ? (FACT_LABELS[k] ?? k) : `${FACT_LABELS[k] ?? k}: ${v}`,
                )
                .join(', ') || 'None'}
            </dd>
            {d.model && (
              <>
                <dt className="text-gray-600">Model</dt>
                <dd>
                  {d.model}
                  {d.latency_ms !== null ? ` · ${(d.latency_ms / 1000).toFixed(1)} s` : ''}
                  {d.input_tokens !== null
                    ? ` · ${d.input_tokens} in / ${d.output_tokens ?? 0} out tokens`
                    : ''}
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
    </li>
  );
}

const REPLY_STATUS: Record<InboxReply['status'], string> = {
  draft: 'Draft, not sent (test message)',
  queued: 'Waiting to send',
  sent: 'Sent',
  failed: 'Failed',
};

const ANSWERED: Record<'yes' | 'partly' | 'no', string> = {
  yes: 'Answered',
  partly: 'Partly answered',
  no: 'Could not answer yet',
};

function sourceSummary(sources: InboxReply['sources']): string {
  const tickets = sources.filter((s) => s.source === 'jira').length;
  const memories = sources.length - tickets;
  return [
    tickets > 0 ? `${tickets} Jira ${tickets === 1 ? 'ticket' : 'tickets'}` : '',
    memories > 0 ? `${memories} ${memories === 1 ? 'memory' : 'memories'}` : '',
  ]
    .filter(Boolean)
    .join(' and ');
}

function Reply({ reply: r, name }: { reply: InboxReply; name: string }) {
  const failed = r.status === 'failed';
  return (
    <div>
      <p className="text-xs text-gray-600">
        <span className="font-medium text-black">{name}</span>
        {r.kind === 'ack' ? ' · first note' : ''} · {REPLY_STATUS[r.status]}
        {r.answered ? ` · ${ANSWERED[r.answered]}` : ''}
        {r.latency_ms !== null ? ` · ${(r.latency_ms / 1000).toFixed(1)} s` : ''}
      </p>
      {failed ? (
        <p role="alert" className="mt-0.5 text-sm font-semibold text-red-600">
          Error: {r.error_code ? (ERROR_LABELS[r.error_code] ?? r.error_code) : r.body}
        </p>
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{r.body}</p>
      )}
      {r.sources.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-gray-600 hover:text-black">
            Based on {sourceSummary(r.sources)}
          </summary>
          <ul className="mt-1 space-y-1 rounded-md bg-gray-100 p-2 text-xs">
            {r.sources.map((s) => (
              <li key={s.id ?? s.memory_id ?? s.snippet} className="[overflow-wrap:anywhere]">
                {s.source === 'jira' && s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-gray-600"
                  >
                    {s.label ?? s.id}
                    <ExternalLink className="size-3" aria-hidden />
                    <span className="sr-only">(opens Jira)</span>
                  </a>
                ) : (
                  s.snippet
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function BackLink({ id }: { id: string }) {
  return (
    <Link
      href={`/employees/${id}`}
      className="mb-4 inline-block text-sm text-gray-600 hover:text-black"
    >
      ← AI employee
    </Link>
  );
}
