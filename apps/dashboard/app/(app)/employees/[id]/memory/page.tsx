import { Brain, Lock } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { apiFetch, getMe } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { FACT_KINDS, getMemory, type Fact, type FactKind, type MemoryPage } from '@/lib/memory';
import type { EmployeeDetail } from '@/lib/types';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { ExtractNow } from './extract-now';

export const metadata: Metadata = { title: 'Memory' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_LABELS: Record<FactKind, string> = {
  decision: 'Decision',
  action_item: 'Action item',
  requirement: 'Requirement',
  technical_fact: 'Technical fact',
  person_fact: 'Who does what',
};

export default async function MemoryPageView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; status?: string; cursor?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (!UUID.test(id)) notFound();
  const kind = FACT_KINDS.find((k) => k === query.kind);
  const showAll = query.status === 'all';
  const cursor = query.cursor && UUID.test(query.cursor) ? query.cursor : undefined;

  const me = await getMe();
  const role = me.member?.role;
  if (role !== 'admin' && role !== 'security_admin') {
    return (
      <>
        <BackLink id={id} />
        <EmptyState
          icon={Lock}
          title="Only admins can read an AI employee’s memory"
          description="Ask an admin or security admin of your organization."
        />
      </>
    );
  }

  const apiParams = new URLSearchParams();
  if (kind) apiParams.set('kind', kind);
  if (showAll) apiParams.set('status', 'all');
  if (cursor) apiParams.set('cursor', cursor);
  let detail: EmployeeDetail;
  let page: MemoryPage;
  try {
    [detail, page] = await Promise.all([
      apiFetch<EmployeeDetail>(`/v1/employees/${id}`),
      getMemory(id, apiParams),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <>
        <BackLink id={id} />
        <LoadError error={err} what="this employee’s memory" />
      </>
    );
  }
  const { employee } = detail;
  const href = (over: { kind?: string | null; status?: string | null; cursor?: string | null }) => {
    const p = new URLSearchParams();
    const k = over.kind === undefined ? kind : over.kind;
    const s = over.status === undefined ? (showAll ? 'all' : null) : over.status;
    if (k) p.set('kind', k);
    if (s) p.set('status', s);
    if (over.cursor) p.set('cursor', over.cursor);
    const qs = p.toString();
    return `/employees/${id}/memory${qs ? `?${qs}` : ''}`;
  };

  return (
    <>
      <BackLink id={id} />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          What {employee.display_name} knows
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Decisions, action items, requirements and other facts pulled out of its conversations once
          they go quiet. Each fact links to the messages it came from and is only used in answers to
          people who could see that conversation.
        </p>
      </div>

      {page.can_extract_now && !cursor && (
        <div className="mb-6">
          <ExtractNow employeeId={id} pending={page.pending_conversations} />
        </div>
      )}

      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm" aria-label="Filter facts">
        <FilterLink href={href({ kind: null })} active={!kind}>
          All kinds
        </FilterLink>
        {FACT_KINDS.map((k) => (
          <FilterLink key={k} href={href({ kind: k })} active={kind === k}>
            {KIND_LABELS[k]}
          </FilterLink>
        ))}
        <Link
          href={href({ status: showAll ? null : 'all' })}
          className="ml-auto text-gray-600 underline underline-offset-4 hover:text-black"
        >
          {showAll ? 'Hide replaced facts' : 'Show replaced facts'}
        </Link>
      </nav>

      {page.facts.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={kind || cursor ? 'No facts here' : 'Nothing remembered yet'}
          description={
            kind || cursor
              ? 'Try another kind.'
              : 'Facts appear after a conversation has been quiet for 10 minutes.'
          }
        />
      ) : (
        <section aria-label="Facts">
          <ul className="divide-y divide-gray-300 border-y border-gray-300">
            {page.facts.map((f) => (
              <FactRow key={f.id} fact={f} />
            ))}
          </ul>
          <nav className="mt-4 flex justify-between text-sm" aria-label="Pages">
            {cursor ? (
              <Link
                href={href({})}
                className="rounded-md border border-black px-3 py-1.5 font-medium hover:bg-gray-100"
              >
                ← Newest
              </Link>
            ) : (
              <span />
            )}
            {page.next_cursor && (
              <Link
                href={href({ cursor: page.next_cursor })}
                className="rounded-md border border-black px-3 py-1.5 font-medium hover:bg-gray-100"
              >
                Older facts →
              </Link>
            )}
          </nav>
        </section>
      )}
    </>
  );
}

function FactRow({ fact: f }: { fact: Fact }) {
  const replaced = f.status === 'superseded';
  const low = f.confidence < 0.6;
  const where =
    f.scope === 'space'
      ? (f.space_name ?? 'a space')
      : f.scope === 'org'
        ? 'everyone'
        : 'direct messages';
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={replaced ? 'muted' : 'outline'}>{KIND_LABELS[f.kind]}</Badge>
        {replaced && <Badge variant="muted">Replaced</Badge>}
        {low && <Badge variant="danger">Unsure ({Math.round(f.confidence * 100)}%)</Badge>}
        <span className="text-xs text-gray-600">
          {formatDate(f.occurred_at)} · from {where}
        </span>
      </div>
      <p
        className={cn(
          'mt-1 text-sm [overflow-wrap:anywhere]',
          replaced && 'text-gray-600 line-through',
        )}
      >
        {f.content}
      </p>
      {f.sources.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-gray-600 hover:text-black">
            From {f.sources.length} {f.sources.length === 1 ? 'message' : 'messages'}
          </summary>
          <ul className="mt-1 space-y-1 rounded-md bg-gray-100 p-2 text-xs">
            {f.sources.map((s) => (
              <li key={s.id} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{s.sender ?? 'Someone'}</span>{' '}
                <span className="text-gray-600">{formatDateTime(s.sent_at)}</span>: {s.snippet}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-md border px-2.5 py-1',
        active ? 'border-black bg-black text-white' : 'border-gray-300 hover:border-black',
      )}
    >
      {children}
    </Link>
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
