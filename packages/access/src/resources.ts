import type { Member, Resource, ResourceType, Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { MAX_TAGS, RESOURCE_TYPE_INFO, TAG_PATTERN } from './catalog';
import { AccessError } from './errors';
import { revokeWhere } from './revoke';

/** The resource registry is kept by organization admins. */
export function requireRegistryAdmin(actor: Member): void {
  if (actor.type !== 'human' || actor.person_role !== 'admin') {
    throw new AccessError('forbidden', 'Only organization admins can change the resource list');
  }
}

export interface ResourceRow extends Resource {
  /** Live grants that name this resource directly. */
  grant_count: number;
}

export async function listResources(
  trx: Tx,
  filter: { type?: ResourceType; includeArchived?: boolean } = {},
): Promise<ResourceRow[]> {
  let query = trx
    .selectFrom('access.resources as r')
    .selectAll('r')
    .select((eb) =>
      eb
        .selectFrom('access.grants as g')
        .select((e) => e.fn.countAll<string>().as('n'))
        .whereRef('g.resource_id', '=', 'r.id')
        .where('g.revoked_at', 'is', null)
        .as('grant_count'),
    );
  if (filter.type) query = query.where('r.type', '=', filter.type);
  if (!filter.includeArchived) query = query.where('r.archived_at', 'is', null);
  const rows = await query.orderBy('r.type').orderBy('r.name').execute();
  return rows.map((r) => ({ ...r, grant_count: Number(r.grant_count ?? 0) }));
}

export async function getResource(trx: Tx, id: string): Promise<Resource> {
  const row = await trx
    .selectFrom('access.resources')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AccessError('not_found', 'Resource not found');
  return row;
}

/** Lower-case, de-duplicate and validate tags. */
export function normalizeTags(raw: readonly string[], field = 'tags'): string[] {
  const tags = [...new Set(raw.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > MAX_TAGS) {
    throw new AccessError('invalid_resource', `Use at most ${MAX_TAGS} tags`, field);
  }
  const bad = tags.find((t) => !TAG_PATTERN.test(t));
  if (bad) {
    throw new AccessError(
      'invalid_resource',
      `“${bad}” isn’t a valid tag. Use lowercase letters, numbers and dashes`,
      field,
    );
  }
  return tags;
}

function normalizeUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AccessError('invalid_resource', 'Enter a full link starting with https://', 'url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AccessError('invalid_resource', 'Enter a full link starting with https://', 'url');
  }
  return parsed.toString();
}

async function checkUnique(trx: Tx, type: ResourceType, externalId: string, exceptId?: string) {
  let query = trx
    .selectFrom('access.resources')
    .select('id')
    .where('type', '=', type)
    .where((eb) => eb(eb.fn('lower', ['external_id']), '=', externalId.toLowerCase()))
    .where('archived_at', 'is', null);
  if (exceptId) query = query.where('id', '<>', exceptId);
  if (await query.executeTakeFirst()) {
    throw new AccessError(
      'resource_exists',
      `This ${RESOURCE_TYPE_INFO[type].noun} is already on the list`,
      'external_id',
    );
  }
}

export interface RegisterResourceInput {
  type: ResourceType;
  externalId: string;
  name: string;
  url?: string | null;
  tags?: string[];
}

/** Add a repository, project, space or file to the list of things that can be granted. */
export async function registerResource(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  input: RegisterResourceInput,
): Promise<Resource> {
  requireRegistryAdmin(actor);
  const info = RESOURCE_TYPE_INFO[input.type];
  const externalId = info.externalId.normalize(input.externalId);
  if (!info.externalId.pattern.test(externalId)) {
    throw new AccessError('invalid_resource', info.externalId.hint, 'external_id');
  }
  const tags = normalizeTags(input.tags ?? []);
  const url = normalizeUrl(input.url);
  await checkUnique(trx, input.type, externalId);

  const resource = await trx
    .insertInto('access.resources')
    .values({
      org_id: ctx.orgId,
      type: input.type,
      external_id: externalId,
      name: input.name.trim() || externalId,
      url,
      tags,
      created_by: actor.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(
    trx,
    ctx,
    {
      action: 'resource.registered',
      resourceType: 'resource',
      resourceId: resource.id,
      details: { type: resource.type, external_id: externalId, name: resource.name, tags },
    },
    {
      type: 'ResourceRegistered',
      aggregateType: 'resource',
      aggregateId: resource.id,
      data: { type: resource.type, external_id: externalId },
    },
  );
  return resource;
}

export interface ResourcePatch {
  name?: string;
  url?: string | null;
  tags?: string[];
}

/** Rename a resource or change its link or tags. Tag changes can widen or narrow access. */
export async function updateResource(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
  patch: ResourcePatch,
): Promise<Resource> {
  requireRegistryAdmin(actor);
  const before = await getResource(trx, id);
  if (before.archived_at) {
    throw new AccessError('invalid_state', 'This resource was removed and can’t be changed');
  }
  const set = {
    ...(patch.name !== undefined ? { name: patch.name.trim() || before.external_id } : {}),
    ...(patch.url !== undefined ? { url: normalizeUrl(patch.url) } : {}),
    ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
  };
  if (Object.keys(set).length === 0) return before;
  const after = await trx
    .updateTable('access.resources')
    .set({ ...set, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const pick = (r: Resource) => ({ name: r.name, url: r.url, tags: r.tags });
  await recordChange(
    trx,
    ctx,
    {
      action: 'resource.updated',
      resourceType: 'resource',
      resourceId: id,
      details: { before: pick(before), after: pick(after) },
    },
    {
      type: 'ResourceUpdated',
      aggregateType: 'resource',
      aggregateId: id,
      // Tag changes change who a tag-scoped grant covers; access caches must refresh.
      data: { fields: Object.keys(set) },
    },
  );
  return after;
}

/**
 * Take a resource off the list. Grants that name it are revoked in the same transaction;
 * type-wide grants simply stop covering it.
 */
export async function archiveResource(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
): Promise<{ revoked: number }> {
  requireRegistryAdmin(actor);
  const resource = await getResource(trx, id);
  if (resource.archived_at) return { revoked: 0 };
  await trx
    .updateTable('access.resources')
    .set({ archived_at: new Date(), updated_at: new Date() })
    .where('id', '=', id)
    .execute();
  const revoked = await revokeWhere(trx, ctx, { resourceId: id }, 'resource_removed');
  await recordChange(
    trx,
    ctx,
    {
      action: 'resource.archived',
      resourceType: 'resource',
      resourceId: id,
      details: {
        type: resource.type,
        external_id: resource.external_id,
        grants_revoked: revoked,
      },
    },
    {
      type: 'ResourceArchived',
      aggregateType: 'resource',
      aggregateId: id,
      data: { type: resource.type },
    },
  );
  return { revoked };
}
