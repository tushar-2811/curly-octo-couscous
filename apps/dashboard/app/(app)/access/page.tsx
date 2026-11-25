import { KeyRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/ui/states';
import { getAccessCatalog, listResources } from '@/lib/access';
import { getMe } from '@/lib/api';
import type { AccessCatalog, Resource, ResourceType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AddResource } from './resource-form';
import { ResourceList } from './resource-list';

export const metadata: Metadata = { title: 'Access' };
export const dynamic = 'force-dynamic';

const TYPES: readonly string[] = ['repo', 'jira_project', 'chat_space', 'figma_file'];

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type: rawType } = await searchParams;
  const type = rawType && TYPES.includes(rawType) ? (rawType as ResourceType) : undefined;
  const me = await getMe();
  const isAdmin = me.member?.role === 'admin';

  const header = (
    <PageHeader
      title="Access"
      description="Repositories, Jira projects, Chat spaces and Figma files your AI employees can be granted. A new employee has no access until you grant it on its page."
    />
  );

  let catalog: AccessCatalog;
  let resources: Resource[];
  try {
    [catalog, resources] = await Promise.all([getAccessCatalog(), listResources(type)]);
  } catch (err) {
    return (
      <>
        {header}
        <LoadError error={err} what="resources" />
      </>
    );
  }
  const current = catalog.resource_types.find((t) => t.key === type);

  return (
    <>
      {header}
      {isAdmin && <AddResource types={catalog.resource_types} defaultType={type} />}

      <nav aria-label="Filter by type" className="mb-4 flex flex-wrap gap-1 text-sm">
        {[
          { key: undefined, label: 'All' },
          ...catalog.resource_types.map((t) => ({ key: t.key, label: t.plural })),
        ].map((t) => {
          const active = t.key === type;
          return (
            <Link
              key={t.key ?? 'all'}
              href={t.key ? `/access?type=${t.key}` : '/access'}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5',
                active ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-black',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {resources.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={current ? `No ${current.nouns} yet` : 'Nothing to grant yet'}
          description={
            isAdmin
              ? 'Add the repositories, Jira projects and Chat spaces your AI employees will work in. Once integrations are connected, they will be found automatically.'
              : 'An admin has not added any resources yet.'
          }
        />
      ) : (
        <ResourceList resources={resources} types={catalog.resource_types} canEdit={isAdmin} />
      )}
    </>
  );
}
