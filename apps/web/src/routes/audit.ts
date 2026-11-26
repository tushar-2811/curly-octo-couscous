import { withTenant, type AuditLog, type Tx } from '@aiw/db';
import { auditFacets, searchAudit } from '@aiw/platform';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { AppError } from '../errors';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-26')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real date');

const query = z
  .object({
    actor: z.union([z.literal('system'), z.uuid('Choose someone from the list')]).optional(),
    resource: z.uuid('Invalid item id').optional(),
    category: z
      .string()
      .regex(/^[a-z_]{1,40}$/, 'Unknown category')
      .optional(),
    action: z
      .string()
      .regex(/^[a-z_.]{1,80}$/, 'Unknown action')
      .optional(),
    outcome: z.enum(['success', 'denied', 'failure']).optional(),
    from: day.optional(),
    to: day.optional(),
    cursor: z.uuid('Invalid page').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: 'The end date is before the start date',
  });

/** Names for the people, AI employees, units and organization in a page of entries. */
async function names(trx: Tx, entries: AuditLog[]) {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.actor_member_id) ids.add(e.actor_member_id);
    if (e.resource_id && /^[0-9a-f-]{36}$/i.test(e.resource_id)) ids.add(e.resource_id);
  }
  const list = [...ids];
  if (list.length === 0) return new Map<string, { name: string; kind: string }>();
  const [members, units, orgs] = await Promise.all([
    trx
      .selectFrom('workforce.members')
      .select(['id', 'display_name', 'type'])
      .where('id', 'in', list)
      .execute(),
    trx.selectFrom('workforce.org_units').select(['id', 'name']).where('id', 'in', list).execute(),
    trx
      .selectFrom('workforce.organizations')
      .select(['id', 'name'])
      .where('id', 'in', list)
      .execute(),
  ]);
  return new Map<string, { name: string; kind: string }>([
    ...members.map((m) => [m.id, { name: m.display_name, kind: m.type }] as const),
    ...units.map((u) => [u.id, { name: u.name, kind: 'org_unit' }] as const),
    ...orgs.map((o) => [o.id, { name: o.name, kind: 'organization' }] as const),
  ]);
}

/** Audit log viewer (Phase 1, slice 7). Admins and security admins only. */
export function registerAuditRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;

  async function requireAuditor(request: Parameters<typeof requireMember>[0]) {
    const session = await requireMember(request, db);
    const role = session.member.person_role;
    if (role !== 'admin' && role !== 'security_admin') {
      throw new AppError(
        403,
        'forbidden',
        'Only admins can view the audit log',
        'Ask an admin or security admin of your organization.',
      );
    }
    return session;
  }

  app.get('/v1/audit', async (request) => {
    const { ctx } = await requireAuditor(request);
    const q = query.parse(request.query);
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : undefined;
    if (to) to.setUTCDate(to.getUTCDate() + 1); // the whole end day
    const started = performance.now();
    const { entries, nextCursor, lookup } = await withTenant(db, ctx.orgId, async (trx) => {
      const page = await searchAudit(trx, {
        ...(q.actor ? { actor: q.actor } : {}),
        ...(q.resource ? { resourceId: q.resource } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.outcome ? { outcome: q.outcome } : {}),
        ...(q.from ? { from: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(to ? { to } : {}),
        ...(q.cursor ? { before: q.cursor } : {}),
        limit: q.limit,
      });
      return { ...page, lookup: await names(trx, page.entries) };
    });
    request.log.info(
      {
        filters: Object.keys(q).filter((k) => k !== 'limit'),
        results: entries.length,
        has_more: nextCursor !== null,
        duration_ms: Math.round(performance.now() - started),
      },
      'audit searched',
    );
    return {
      entries: entries.map((e) => {
        const actor = e.actor_member_id ? lookup.get(e.actor_member_id) : undefined;
        const resource = e.resource_id ? lookup.get(e.resource_id) : undefined;
        return {
          id: e.id,
          occurred_at: new Date(e.occurred_at).toISOString(),
          actor:
            e.actor_type === 'system'
              ? { type: 'system', id: null, name: null, kind: null }
              : {
                  type: 'member',
                  id: e.actor_member_id,
                  name: actor?.name ?? null,
                  kind: actor?.kind ?? null,
                },
          action: e.action,
          resource: {
            type: e.resource_type,
            id: e.resource_id,
            name: resource?.name ?? null,
            kind: resource?.kind ?? null,
          },
          outcome: e.outcome,
          request_id: e.request_id,
          details: e.details,
        };
      }),
      next_cursor: nextCursor,
    };
  });

  app.get('/v1/audit/filters', async (request) => {
    const { ctx } = await requireAuditor(request);
    return withTenant(db, ctx.orgId, async (trx) => {
      const facets = await auditFacets(trx);
      const people =
        facets.actorIds.length === 0
          ? []
          : await trx
              .selectFrom('workforce.members')
              .select(['id', 'display_name', 'type'])
              .where('id', 'in', facets.actorIds)
              .orderBy('display_name')
              .execute();
      return {
        actors: [
          ...people.map((p) => ({ id: p.id, name: p.display_name, kind: p.type })),
          ...(facets.hasSystem
            ? [{ id: 'system', name: 'System (automatic)', kind: 'system' }]
            : []),
        ],
        actions: facets.actions,
      };
    });
  });
}
