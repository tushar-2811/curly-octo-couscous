import { Lock, ScrollText, SearchX } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { FormAlert } from '@/components/form-alert';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import {
  getAuditFilters,
  searchAudit,
  type AuditEntry,
  type AuditFilters,
  type AuditPage,
} from '@/lib/audit';
import { actionLabel, actionSummary, CATEGORY_LABELS } from '@/lib/audit-labels';
import { cn, formatDateTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

type Params = Partial<
  Record<'actor' | 'resource' | 'category' | 'outcome' | 'from' | 'to' | 'cursor', string>
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = [
  { value: 'success', label: 'Succeeded' },
  { value: 'failure', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
];
const FIELD =
  'h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:border-black';

/** Keep only well-formed filters; say which ones were ignored. */
function readFilters(raw: Params) {
  const problems: string[] = [];
  const f: Params = {};
  if (raw.actor && (raw.actor === 'system' || UUID.test(raw.actor))) f.actor = raw.actor;
  if (raw.resource && UUID.test(raw.resource)) f.resource = raw.resource;
  if (raw.category && /^[a-z_]{1,40}$/.test(raw.category)) f.category = raw.category;
  if (raw.outcome && OUTCOMES.some((o) => o.value === raw.outcome)) f.outcome = raw.outcome;
  if (raw.cursor && UUID.test(raw.cursor)) f.cursor = raw.cursor;
  for (const key of ['from', 'to'] as const) {
    const v = raw[key];
    if (!v) continue;
    if (DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) f[key] = v;
    else problems.push(`The ${key === 'from' ? 'start' : 'end'} date isn’t a valid date.`);
  }
  if (f.from && f.to && f.from > f.to) {
    problems.push('The end date is before the start date.');
    delete f.to;
  }
  return { filters: f, problems };
}

function query(filters: Params, patch: Params = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/audit?${s}` : '/audit';
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await getMe();
  const role = me.member?.role;
  const header = (
    <PageHeader
      title="Audit log"
      description="Every change in your organization: who did it, when, and to what. Entries can’t be edited or deleted."
    />
  );

  if (role !== 'admin' && role !== 'security_admin') {
    return (
      <>
        {header}
        <EmptyState
          icon={Lock}
          title="Only admins can view the audit log"
          description="Ask an admin or security admin of your organization if you need to see a change."
        />
      </>
    );
  }

  const { filters, problems } = readFilters(await searchParams);
  const apiParams = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) apiParams.set(k, v);

  let page: AuditPage;
  let options: AuditFilters;
  try {
    [page, options] = await Promise.all([searchAudit(apiParams), getAuditFilters()]);
  } catch (err) {
    return (
      <>
        {header}
        <LoadError error={err} what="the audit log" />
      </>
    );
  }

  const filtered = (['actor', 'resource', 'category', 'outcome', 'from', 'to'] as const).some(
    (k) => filters[k],
  );
  const categories = [...new Set(options.actions.map((a) => a.split('.')[0]!))].sort();
  const resourceName =
    filters.resource &&
    (page.entries.find((e) => e.resource.id === filters.resource)?.resource.name ?? 'this item');

  return (
    <>
      {header}

      {problems.length > 0 && (
        <div className="mb-4">
          <FormAlert title="Some filters were ignored" detail={problems.join(' ')} />
        </div>
      )}

      {filters.resource && (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-black px-4 py-2.5 text-sm">
          Showing the history of <span className="font-medium">{resourceName}</span>
          <Link
            href={query({ ...filters, resource: undefined, cursor: undefined })}
            className="ml-auto text-gray-600 underline underline-offset-4 hover:text-black"
          >
            Show everything
          </Link>
        </p>
      )}

      <form
        action="/audit"
        role="search"
        aria-label="Filter the audit log"
        className="mb-6 grid gap-3 rounded-lg border border-gray-300 p-4 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]"
      >
        {filters.resource && <input type="hidden" name="resource" value={filters.resource} />}
        <Select
          id="audit-actor"
          name="actor"
          label="Who"
          value={filters.actor}
          options={options.actors.map((a) => ({
            value: a.id,
            label: a.kind === 'ai' ? `${a.name} (AI)` : a.name,
          }))}
          any="Anyone"
        />
        <Select
          id="audit-category"
          name="category"
          label="What"
          value={filters.category}
          options={categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))}
          any="Any change"
        />
        <Select
          id="audit-outcome"
          name="outcome"
          label="Result"
          value={filters.outcome}
          options={OUTCOMES}
          any="Any result"
        />
        <DateField id="audit-from" name="from" label="From" value={filters.from} />
        <DateField id="audit-to" name="to" label="To" value={filters.to} />
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="h-9 rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
          >
            Apply
          </button>
          {filtered && (
            <Link
              href="/audit"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm text-gray-600 hover:bg-gray-100 hover:text-black"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {page.entries.length === 0 ? (
        filtered || filters.cursor ? (
          <EmptyState
            icon={SearchX}
            title="No entries match"
            description="Try a wider date range or fewer filters."
            action={
              <Link href="/audit" className="text-sm font-medium underline underline-offset-4">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="Nothing recorded yet"
            description="Changes to your organization, people and AI employees will appear here."
          />
        )
      ) : (
        <>
          <ol
            className="divide-y divide-gray-300 rounded-lg border border-gray-300 bg-white"
            aria-label="Audit entries, newest first"
          >
            {page.entries.map((e) => (
              <Entry key={e.id} entry={e} filters={filters} />
            ))}
          </ol>
          <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-sm">
            {filters.cursor ? (
              <Link
                href={query(filters, { cursor: undefined })}
                className="text-gray-600 underline underline-offset-4 hover:text-black"
              >
                ← Newest
              </Link>
            ) : (
              <span />
            )}
            {page.next_cursor && (
              <Link
                href={query(filters, { cursor: page.next_cursor })}
                className="rounded-md border border-black px-3 py-1.5 font-medium hover:bg-gray-100"
              >
                Older entries →
              </Link>
            )}
          </nav>
        </>
      )}
    </>
  );
}

function resourceHref(r: AuditEntry['resource']): string | null {
  if (!r.id) return null;
  if (r.kind === 'ai') return `/employees/${r.id}`;
  if (r.kind === 'human') return `/people/${r.id}`;
  if (r.kind === 'org_unit') return '/organization';
  if (r.kind === 'organization') return '/settings';
  return null;
}

function Entry({ entry: e, filters }: { entry: AuditEntry; filters: Params }) {
  const failed = e.outcome !== 'success';
  const summary = actionSummary(e.action, e.details);
  const who =
    e.actor.type === 'system'
      ? 'System'
      : (e.actor.name ?? 'Someone no longer in the organization');
  const href = resourceHref(e.resource);
  const target =
    e.resource.name ??
    (e.resource.type === 'member' ? 'a removed person' : e.resource.type.replaceAll('_', ' '));
  const sameAsActor = e.resource.id !== null && e.resource.id === e.actor.id;

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time dateTime={e.occurred_at} className="w-52 shrink-0 font-mono text-xs text-gray-600">
          {formatDateTime(e.occurred_at)}
        </time>
        <p className="min-w-0 flex-1">
          <span className="font-medium">{who}</span>{' '}
          <span className={cn(failed && 'text-red-600')}>{actionLabel(e.action)}</span>
          {!sameAsActor && (
            <>
              {' '}
              {href ? (
                <Link href={href} className="underline underline-offset-4 hover:text-gray-600">
                  {target}
                </Link>
              ) : (
                <span>{target}</span>
              )}
            </>
          )}
          {summary && <span className="text-gray-600"> · {summary}</span>}
        </p>
        {failed && <Badge variant="danger">{e.outcome === 'denied' ? 'Denied' : 'Failed'}</Badge>}
      </div>
      <details className="mt-1.5 sm:ml-[13.75rem]">
        <summary className="cursor-pointer text-xs text-gray-600 hover:text-black">Details</summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md bg-gray-100 p-3 text-xs sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Action</dt>
          <dd className="font-mono">{e.action}</dd>
          {Object.entries(e.details).map(([k, v]) => (
            <Detail key={k} name={k} value={v} />
          ))}
          {e.request_id && (
            <>
              <dt className="text-gray-600">Request ID</dt>
              <dd className="font-mono break-all">{e.request_id}</dd>
            </>
          )}
          {e.resource.id && !filters.resource && (
            <>
              <dt className="text-gray-600">History</dt>
              <dd>
                <Link
                  href={query({ resource: e.resource.id })}
                  className="underline underline-offset-4"
                >
                  Everything about {target}
                </Link>
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}

function Detail({ name, value }: { name: string; value: unknown }) {
  const label = name.replaceAll('_', ' ');
  let shown: ReactNode;
  if (value === null || value === undefined || value === '') shown = '—';
  else if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) {
    shown = value.length ? value.join(', ') : '—';
  } else if (typeof value === 'object') {
    shown = (
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  } else shown = String(value);
  return (
    <>
      <dt className="text-gray-600 first-letter:uppercase">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{shown}</dd>
    </>
  );
}

function Select({
  id,
  name,
  label,
  value,
  options,
  any,
}: {
  id: string;
  name: string;
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  any: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ''} className={FIELD}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DateField({
  id,
  name,
  label,
  value,
}: {
  id: string;
  name: string;
  label: string;
  value: string | undefined;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label} <span className="font-normal text-gray-600">(UTC)</span>
      </label>
      <input id={id} name={name} type="date" defaultValue={value ?? ''} className={FIELD} />
    </div>
  );
}
