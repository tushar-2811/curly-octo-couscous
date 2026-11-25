import {
  ACTIONS,
  archiveResource,
  authorize,
  canManageGrants,
  createGrant,
  effectivePermissions,
  isAction,
  listGrants,
  listResources,
  registerResource,
  RESOURCE_TYPE_INFO,
  RESOURCE_TYPES,
  revokeGrant,
  updateGrant,
  updateResource,
} from '@aiw/access';
import { withTenant, type ResourceType } from '@aiw/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { effectiveDto, grantDto, resourceDto } from '../dto';

const TYPES = RESOURCE_TYPES as [ResourceType, ...ResourceType[]];
const resourceType = z.enum(TYPES, { error: 'Choose a type' });
const idParam = z.object({ id: z.uuid('Invalid id') });
const grantParams = z.object({ id: z.uuid('Invalid id'), grantId: z.uuid('Invalid id') });
const tags = z.array(z.string().max(32, 'Tags are at most 32 characters')).max(20, 'At most 20');
const branches = z
  .array(z.string().max(100, 'Branch patterns are at most 100 characters'))
  .max(20, 'At most 20');
const level = z.enum(['read', 'write'], { error: 'Choose read or write' });
const effect = z.enum(['allow', 'deny'], { error: 'Choose allow or block' });

const createResourceBody = z.object({
  type: resourceType,
  external_id: z.string().trim().min(1, 'Enter the id').max(300, 'Use at most 300 characters'),
  name: z.string().trim().max(120, 'Use at most 120 characters').default(''),
  url: z.string().trim().max(2000, 'Use at most 2,000 characters').nullable().default(null),
  tags: tags.default([]),
});

const updateResourceBody = z
  .object({
    name: z.string().trim().max(120, 'Use at most 120 characters').optional(),
    url: z.string().trim().max(2000).nullable().optional(),
    tags: tags.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const listResourcesQuery = z.object({
  type: resourceType.optional(),
  include_archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const createGrantBody = z.object({
  resource_type: resourceType,
  resource_id: z.uuid('Choose an item from the list').nullable().default(null),
  effect: effect.default('allow'),
  level,
  tags: tags.default([]),
  branches: branches.default([]),
});

const updateGrantBody = z
  .object({
    effect: effect.optional(),
    level: level.optional(),
    tags: tags.optional(),
    branches: branches.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const authorizeQuery = z.object({
  action: z.string().refine(isAction, 'Choose an action'),
  resource_id: z.uuid('Choose a resource'),
  branch: z.string().trim().max(100).optional(),
});

/** Resource registry, grants and permission checks (Phase 1, slice 4). */
export function registerAccessRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;

  app.get('/v1/access/catalog', async (request) => {
    await requireMember(request, db);
    return {
      resource_types: RESOURCE_TYPES.map((t) => {
        const info = RESOURCE_TYPE_INFO[t];
        return {
          key: t,
          label: info.label,
          plural: info.plural,
          noun: info.noun,
          nouns: info.nouns,
          levels: info.levels.map((l) => ({ key: l, help: info.levelHelp[l] ?? '' })),
          external_id: { example: info.externalId.example, hint: info.externalId.hint },
        };
      }),
      actions: Object.entries(ACTIONS).map(([key, a]) => ({
        key,
        resource_type: a.type,
        level: a.level,
        label: a.label,
        needs_branch: 'branch' in a && a.branch === true,
      })),
    };
  });

  app.get('/v1/resources', async (request) => {
    const { ctx } = await requireMember(request, db);
    const query = listResourcesQuery.parse(request.query);
    const rows = await withTenant(db, ctx.orgId, (trx) =>
      listResources(trx, {
        ...(query.type ? { type: query.type } : {}),
        includeArchived: query.include_archived,
      }),
    );
    return { resources: rows.map(resourceDto) };
  });

  app.post('/v1/resources', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const body = createResourceBody.parse(request.body);
    const resource = await withTenant(db, ctx.orgId, (trx) =>
      registerResource(trx, ctx, member, {
        type: body.type,
        externalId: body.external_id,
        name: body.name,
        url: body.url,
        tags: body.tags,
      }),
    );
    request.log.info(
      { resource_id: resource.id, type: resource.type, external_id: resource.external_id },
      'resource registered',
    );
    return reply.status(201).send({ resource: resourceDto(resource) });
  });

  app.patch('/v1/resources/:id', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = updateResourceBody.parse(request.body);
    const resource = await withTenant(db, ctx.orgId, (trx) =>
      updateResource(trx, ctx, member, id, body),
    );
    request.log.info({ resource_id: id, fields: Object.keys(body) }, 'resource updated');
    return { resource: resourceDto(resource) };
  });

  app.delete('/v1/resources/:id', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const result = await withTenant(db, ctx.orgId, (trx) => archiveResource(trx, ctx, member, id));
    request.log.info({ resource_id: id, grants_revoked: result.revoked }, 'resource removed');
    return { grants_revoked: result.revoked };
  });

  app.get('/v1/employees/:id/access', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const query = z
      .object({
        include_revoked: z
          .enum(['true', 'false'])
          .optional()
          .transform((v) => v === 'true'),
      })
      .parse(request.query);
    return withTenant(db, ctx.orgId, async (trx) => {
      const [grants, effective, canManage] = await Promise.all([
        listGrants(trx, id, { includeRevoked: query.include_revoked }),
        effectivePermissions(trx, id),
        canManageGrants(trx, member, id),
      ]);
      return {
        grants: grants.map(grantDto),
        effective: effective.map(effectiveDto),
        can_manage: canManage,
        can_revoke:
          canManage || (member.person_role === 'security_admin' && member.status === 'active'),
      };
    });
  });

  app.post('/v1/employees/:id/grants', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = createGrantBody.parse(request.body);
    const grant = await withTenant(db, ctx.orgId, async (trx) => {
      const g = await createGrant(trx, ctx, member, id, {
        resourceType: body.resource_type,
        resourceId: body.resource_id,
        effect: body.effect,
        level: body.level,
        tags: body.tags,
        branches: body.branches,
      });
      return (await listGrants(trx, id)).find((row) => row.id === g.id)!;
    });
    request.log.info(
      {
        employee_id: id,
        grant_id: grant.id,
        resource_type: grant.resource_type,
        resource_id: grant.resource_id,
        effect: grant.effect,
        level: grant.level,
      },
      'grant created',
    );
    return reply.status(201).send({ grant: grantDto(grant) });
  });

  app.patch('/v1/employees/:id/grants/:grantId', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id, grantId } = grantParams.parse(request.params);
    const body = updateGrantBody.parse(request.body);
    const grant = await withTenant(db, ctx.orgId, async (trx) => {
      await updateGrant(trx, ctx, member, id, grantId, body);
      return (await listGrants(trx, id)).find((row) => row.id === grantId)!;
    });
    request.log.info(
      { employee_id: id, grant_id: grantId, fields: Object.keys(body) },
      'grant updated',
    );
    return { grant: grantDto(grant) };
  });

  app.delete('/v1/employees/:id/grants/:grantId', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const { id, grantId } = grantParams.parse(request.params);
    await withTenant(db, ctx.orgId, (trx) => revokeGrant(trx, ctx, member, id, grantId));
    request.log.info({ employee_id: id, grant_id: grantId }, 'grant revoked');
    return reply.status(204).send();
  });

  // Read-only "what if" check used by the dashboard; brokers call authorize() in-process.
  app.get('/v1/employees/:id/authorize', async (request) => {
    const { ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const query = authorizeQuery.parse(request.query);
    const action = query.action as keyof typeof ACTIONS;
    const decision = await withTenant(db, ctx.orgId, (trx) =>
      authorize(trx, id, action, query.resource_id, { branch: query.branch ?? null }),
    );
    request.log.info(
      {
        employee_id: id,
        action,
        resource_id: query.resource_id,
        allowed: decision.allowed,
        reason: decision.reason,
      },
      'access checked',
    );
    return { decision };
  });
}
