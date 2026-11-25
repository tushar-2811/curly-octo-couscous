'use client';

import { ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { clientFetch, ClientApiError } from '@/lib/client-api';
import type { Resource, ResourceTypeInfo } from '@/lib/types';
import { ResourceForm } from './resource-form';

export function ResourceList({
  resources,
  types,
  canEdit,
}: {
  resources: Resource[];
  types: ResourceTypeInfo[];
  canEdit: boolean;
}) {
  const label = new Map(types.map((t) => [t.key, t.label]));
  return (
    <ul className="divide-y divide-gray-300 rounded-lg border border-gray-300 bg-white">
      {resources.map((r) => (
        <ResourceItem
          key={r.id}
          resource={r}
          typeLabel={label.get(r.type) ?? r.type}
          types={types}
          canEdit={canEdit}
        />
      ))}
    </ul>
  );
}

function ResourceItem({
  resource,
  typeLabel,
  types,
  canEdit,
}: {
  resource: Resource;
  typeLabel: string;
  types: ResourceTypeInfo[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const grants = resource.grant_count ?? 0;

  async function remove() {
    setPending(true);
    setError(null);
    try {
      await clientFetch(`/v1/resources/${resource.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setPending(false);
    }
  }

  if (mode === 'edit') {
    return (
      <li className="p-4">
        <p className="mb-4 text-sm font-medium">
          Edit {typeLabel.toLowerCase()} <span className="font-mono">{resource.external_id}</span>
        </p>
        <ResourceForm types={types} resource={resource} onDone={() => setMode('view')} />
      </li>
    );
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{resource.name}</span>
            <Badge variant="muted">{typeLabel}</Badge>
            {resource.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-gray-600">
            <span className="font-mono">{resource.external_id}</span>
            {resource.url && (
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 hover:text-black"
              >
                <ExternalLink className="size-3" aria-hidden />
                <span className="sr-only">Open {resource.name}</span>
              </a>
            )}
          </div>
        </div>
        <span className="text-xs text-gray-600">
          {grants === 0 ? 'Not granted' : `In ${grants} access ${grants === 1 ? 'rule' : 'rules'}`}
        </span>
        {canEdit && mode === 'view' && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setMode('edit')}>
              <Pencil className="size-4" aria-hidden />
              <span className="sr-only">Edit {resource.name}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('remove')}>
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Remove {resource.name}</span>
            </Button>
          </div>
        )}
      </div>

      {mode === 'remove' && (
        <div className="mt-3 space-y-3 rounded-md border border-red-600 bg-red-50 p-3" role="alert">
          <p className="text-sm">
            <span className="font-semibold text-red-600">Remove {resource.name}?</span>{' '}
            {grants > 0
              ? `${grants} access ${grants === 1 ? 'rule names' : 'rules name'} it and will be revoked. `
              : ''}
            Grants on every {typeLabel.toLowerCase()} stop covering it. Its history is kept.
          </p>
          {error && (
            <FormAlert title={error.title} detail={error.detail} requestId={error.requestId} />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-red-600 hover:bg-black"
              loading={pending}
              onClick={() => void remove()}
            >
              {pending ? 'Removing' : 'Remove'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setMode('view');
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
