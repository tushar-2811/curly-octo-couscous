import { Bot, Search, UserPlus, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { getMe } from '@/lib/api';
import { listPeople } from '@/lib/structure';
import { ROLE_LABELS, type MemberRow } from '@/lib/types';
import { MemberStatus } from './member-status';

export const metadata: Metadata = { title: 'People' };
export const dynamic = 'force-dynamic';

const STATUS_FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'deactivated', label: 'Deactivated' },
  { value: 'all', label: 'All' },
] as const;

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 100);
  const status = STATUS_FILTERS.some((f) => f.value === params.status) ? params.status! : 'active';
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';

  const header = (
    <PageHeader
      title="People"
      description="Everyone in your organization, their team and who they report to."
      actions={
        isAdmin ? (
          <Link
            href="/people/new"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
          >
            <UserPlus className="size-4" aria-hidden />
            Add person
          </Link>
        ) : undefined
      }
    />
  );

  let people: MemberRow[];
  try {
    people = await listPeople({
      type: 'human',
      q,
      status: status === 'all' ? undefined : status,
    });
  } catch (err) {
    return (
      <>
        {header}
        <LoadError error={err} what="people" />
      </>
    );
  }

  return (
    <>
      {header}
      <form role="search" className="mb-4 flex flex-col gap-2 sm:flex-row" action="/people">
        <div className="relative flex-1">
          <label htmlFor="people-q" className="sr-only">
            Search by name, email or title
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-600"
            aria-hidden
          />
          <input
            id="people-q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search by name, email or title"
            maxLength={100}
            className="block h-9 w-full rounded-md border border-gray-300 bg-white pl-9 pr-3 text-sm placeholder:text-gray-600 focus-visible:border-black"
          />
        </div>
        <label htmlFor="people-status" className="sr-only">
          Status
        </label>
        <select
          id="people-status"
          name="status"
          defaultValue={status}
          className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:border-black"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-9 rounded-md border border-black bg-white px-4 text-sm font-medium hover:bg-gray-100"
        >
          Search
        </button>
      </form>

      {people.length === 0 ? (
        q || status !== 'active' ? (
          <EmptyState
            icon={Search}
            title="No one matches"
            description="Try a different name, email or title, or change the status filter."
            action={
              <Link href="/people" className="text-sm font-medium underline underline-offset-4">
                Clear search
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={Users}
            title="No people yet"
            description="Add the people who will work with your AI employees."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-300 bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              {people.length} {people.length === 1 ? 'person' : 'people'}
            </caption>
            <thead className="border-b border-gray-300 text-xs text-gray-600">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                  Team
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">
                  Reports to
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">
                  Role
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300">
              {people.map((p) => (
                <tr key={p.id} className="hover:bg-gray-100">
                  <td className="px-4 py-2.5">
                    <Link href={`/people/${p.id}`} className="font-medium hover:underline">
                      {p.display_name}
                    </Link>
                    {p.type === 'ai' && (
                      <Bot
                        className="ml-1.5 inline size-4 align-text-bottom"
                        aria-label="AI employee"
                      />
                    )}
                    <div className="text-xs text-gray-600">{p.title ?? p.email}</div>
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">{p.org_unit?.name ?? '—'}</td>
                  <td className="hidden px-4 py-2.5 lg:table-cell">{p.manager?.name ?? '—'}</td>
                  <td className="hidden px-4 py-2.5 sm:table-cell">
                    {p.role ? ROLE_LABELS[p.role] : <Badge variant="muted">AI</Badge>}
                  </td>
                  <td className="px-4 py-2.5">
                    <MemberStatus member={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
