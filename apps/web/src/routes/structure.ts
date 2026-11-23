import { withTenant } from '@aiw/db';
import {
  addPerson,
  createOrgUnit,
  deleteOrgUnit,
  directReports,
  getMemberRow,
  listMembers,
  listOrgUnits,
  setLineManager,
  updateMember,
  updateOrgUnit,
} from '@aiw/workforce';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { memberRowDto, orgUnitDto } from '../dto';

const idParam = z.object({ id: z.uuid('Invalid id') });
const name = z.string().trim().min(1, 'Enter a name').max(120, 'Use at most 120 characters');
const kind = z.enum(['department', 'team', 'other'], { error: 'Choose department, team or other' });
const role = z.enum(['admin', 'security_admin', 'manager', 'member'], { error: 'Choose a role' });
const optionalId = z.uuid('Invalid id').nullable();

const createUnitBody = z.object({ name, kind, parent_id: optionalId.default(null) });
const updateUnitBody = z
  .object({ name: name.optional(), kind: kind.optional(), parent_id: optionalId.optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const listMembersQuery = z.object({
  type: z.enum(['human', 'ai']).optional(),
  status: z.enum(['active', 'deactivated']).optional(),
  org_unit_id: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});

const createPersonBody = z.object({
  display_name: name,
  email: z.email('Enter a valid email address').max(254),
  title: z.string().trim().max(120).nullable().default(null),
  role: role.default('member'),
  org_unit_id: optionalId.default(null),
  manager_id: optionalId.default(null),
});

const updateMemberBody = z
  .object({
    display_name: name.optional(),
    title: z.string().trim().max(120).nullable().optional(),
    role: role.optional(),
    org_unit_id: optionalId.optional(),
    manager_id: optionalId.optional(),
    status: z.enum(['active', 'deactivated']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

/** Departments, teams, people and reporting lines (Phase 1, slice 2). */
export function registerStructureRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;

  app.get('/v1/org-units', async (request) => {
    const { ctx } = await requireMember(request, db);
    const units = await withTenant(db, ctx.orgId, (trx) => listOrgUnits(trx));
    return { units: units.map(orgUnitDto) };
  });

  app.post('/v1/org-units', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const body = createUnitBody.parse(request.body);
    const unit = await withTenant(db, ctx.orgId, (trx) =>
      createOrgUnit(trx, ctx, member, {
        name: body.name,
        kind: body.kind,
        parentId: body.parent_id,
      }),
    );
    request.log.info({ org_unit_id: unit.id, kind: unit.kind }, 'org unit created');
    return reply.status(201).send({ unit: orgUnitDto(unit) });
  });

  app.patch('/v1/org-units/:id', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = updateUnitBody.parse(request.body);
    const unit = await withTenant(db, ctx.orgId, (trx) =>
      updateOrgUnit(trx, ctx, member, id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.parent_id !== undefined ? { parentId: body.parent_id } : {}),
      }),
    );
    request.log.info({ org_unit_id: id }, 'org unit updated');
    return { unit: orgUnitDto(unit) };
  });

  app.delete('/v1/org-units/:id', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    await withTenant(db, ctx.orgId, (trx) => deleteOrgUnit(trx, ctx, member, id));
    request.log.info({ org_unit_id: id }, 'org unit deleted');
    return reply.status(204).send();
  });

  app.get('/v1/members', async (request) => {
    const { ctx } = await requireMember(request, db);
    const query = listMembersQuery.parse(request.query);
    const rows = await withTenant(db, ctx.orgId, (trx) =>
      listMembers(trx, {
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.org_unit_id ? { orgUnitId: query.org_unit_id } : {}),
        ...(query.q ? { q: query.q } : {}),
      }),
    );
    return { members: rows.map(memberRowDto) };
  });

  app.post('/v1/members', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const body = createPersonBody.parse(request.body);
    const row = await withTenant(db, ctx.orgId, async (trx) => {
      const added = await addPerson(trx, ctx, member, {
        displayName: body.display_name,
        email: body.email,
        title: body.title,
        role: body.role,
        orgUnitId: body.org_unit_id,
        managerId: body.manager_id,
      });
      return getMemberRow(trx, added.id);
    });
    request.log.info({ added_member_id: row.id, role: row.person_role }, 'person added');
    return reply.status(201).send({ member: memberRowDto(row) });
  });

  app.get('/v1/members/:id', async (request) => {
    const { ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const { row, reports } = await withTenant(db, ctx.orgId, async (trx) => ({
      row: await getMemberRow(trx, id),
      reports: await directReports(trx, id),
    }));
    return { member: memberRowDto(row), reports };
  });

  app.patch('/v1/members/:id', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = updateMemberBody.parse(request.body);
    const row = await withTenant(db, ctx.orgId, async (trx) => {
      await updateMember(trx, ctx, member, id, {
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.org_unit_id !== undefined ? { orgUnitId: body.org_unit_id } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      if (body.manager_id !== undefined)
        await setLineManager(trx, ctx, member, id, body.manager_id);
      return getMemberRow(trx, id);
    });
    request.log.info({ updated_member_id: id, fields: Object.keys(body) }, 'member updated');
    return { member: memberRowDto(row) };
  });
}
