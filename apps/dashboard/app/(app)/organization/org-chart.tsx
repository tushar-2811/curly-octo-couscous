'use client';

import { Bot, Building2, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { ClientApiError, clientFetch } from '@/lib/client-api';
import { buildUnitTree, type UnitNode } from '@/lib/org';
import { UNIT_KIND_LABELS, type MemberRow, type OrgUnit } from '@/lib/types';
import { UnitForm } from './unit-form';

export function OrgChart({
  units,
  people,
  isAdmin,
}: {
  units: OrgUnit[];
  people: MemberRow[];
  isAdmin: boolean;
}) {
  const { roots, unassigned } = useMemo(() => buildUnitTree(units, people), [units, people]);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div>
          {adding ? (
            <UnitForm units={units} onDone={() => setAdding(false)} />
          ) : (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add department
            </Button>
          )}
        </div>
      )}

      {roots.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No departments yet"
          description={
            isAdmin
              ? 'Add your first department, then add teams inside it and assign people.'
              : 'An admin has not set up departments or teams yet.'
          }
        />
      ) : (
        <ul className="space-y-2" aria-label="Departments and teams">
          {roots.map((node) => (
            <UnitItem key={node.id} node={node} units={units} isAdmin={isAdmin} />
          ))}
        </ul>
      )}

      {unassigned.length > 0 && (
        <section aria-labelledby="unassigned-heading" className="pt-2">
          <h2 id="unassigned-heading" className="mb-2 text-sm font-semibold">
            Not in a department or team ({unassigned.length})
          </h2>
          <PeopleList people={unassigned} />
        </section>
      )}
    </div>
  );
}

type Mode = 'view' | 'edit' | 'add-child' | 'confirm-delete';

function UnitItem({
  node,
  units,
  isAdmin,
}: {
  node: UnitNode;
  units: OrgUnit[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(node.depth === 0);
  const [mode, setMode] = useState<Mode>('view');
  const count = node.member_count ?? node.members.length;
  const hasContent = node.children.length > 0 || node.members.length > 0;
  const contentId = `unit-${node.id}-content`;

  return (
    <li>
      <div className="rounded-md border border-gray-300 bg-white">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={contentId}
            disabled={!hasContent}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left disabled:cursor-default"
          >
            {hasContent ? (
              open ? (
                <ChevronDown className="size-4 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="size-4 shrink-0" aria-hidden />
              )
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
            <span className="truncate text-sm font-medium">{node.name}</span>
            <Badge variant="muted">{UNIT_KIND_LABELS[node.kind]}</Badge>
            <span className="text-xs text-gray-600">
              {count} {count === 1 ? 'person' : 'people'}
            </span>
          </button>
          {isAdmin && mode === 'view' && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setMode('add-child')}>
                <Plus className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">Add team</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode('edit')}
                aria-label={`Edit ${node.name}`}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode('confirm-delete')}
                aria-label={`Delete ${node.name}`}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          )}
        </div>
        {mode === 'edit' && (
          <div className="border-t border-gray-300 p-3">
            <UnitForm units={units} unit={node} onDone={() => setMode('view')} />
          </div>
        )}
        {mode === 'confirm-delete' && (
          <DeleteConfirm node={node} onCancel={() => setMode('view')} />
        )}
      </div>

      {(open || mode === 'add-child') && (
        <div id={contentId} className="ml-4 mt-2 space-y-2 border-l border-gray-300 pl-4">
          {mode === 'add-child' && (
            <UnitForm units={units} parentId={node.id} onDone={() => setMode('view')} />
          )}
          {open && node.members.length > 0 && <PeopleList people={node.members} />}
          {open && node.children.length > 0 && (
            <ul className="space-y-2">
              {node.children.map((child) => (
                <UnitItem key={child.id} node={child} units={units} isAdmin={isAdmin} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function DeleteConfirm({ node, onCancel }: { node: UnitNode; onCancel: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);

  async function onDelete() {
    setPending(true);
    setError(null);
    try {
      await clientFetch(`/v1/org-units/${node.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-gray-300 p-3">
      {error && <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />}
      <p className="text-sm">
        Delete <span className="font-semibold">{node.name}</span>? A department or team can only be
        deleted once it has no teams or people in it.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onDelete} loading={pending}>
          {pending ? 'Deleting' : 'Delete'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PeopleList({ people }: { people: MemberRow[] }) {
  return (
    <ul className="divide-y divide-gray-300 rounded-md border border-gray-300 bg-white">
      {people.map((p) => (
        <li key={p.id}>
          <Link
            href={p.type === 'ai' ? `/employees/${p.id}` : `/people/${p.id}`}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-100"
          >
            {p.type === 'ai' && <Bot className="size-4 shrink-0" aria-label="AI employee" />}
            <span className="font-medium">{p.display_name}</span>
            {p.title && <span className="truncate text-gray-600">{p.title}</span>}
            {p.manager?.name && (
              <span className="ml-auto hidden shrink-0 text-xs text-gray-600 sm:inline">
                Reports to {p.manager.name}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
