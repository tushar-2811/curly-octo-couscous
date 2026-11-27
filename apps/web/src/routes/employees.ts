import { withTenant } from '@aiw/db';
import {
  findRoleTemplate,
  getEmployee,
  hireEmployee,
  listEmployees,
  listIdentities,
  onboardingChecklist,
  resumeEmployee,
  ROLE_TEMPLATES,
  setCompanyEmail,
  suspendEmployee,
  terminateEmployee,
  updateEmployee,
} from '@aiw/workforce';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, type AuthDeps } from '../auth';
import { employeeDto, identityDto, roleTemplateDto } from '../dto';
import { disconnectIdentities, revokeQuietly } from './identities';

const AI_STATES = [
  'draft',
  'external_identity_pending',
  'identity_connected',
  'integrations_pending',
  'permissions_configured',
  'environment_ready',
  'active',
  'onboarding_failed',
  'suspended',
  'terminated',
] as const;

const idParam = z.object({ id: z.uuid('Invalid id') });
const name = z.string().trim().min(1, 'Enter a name').max(120, 'Use at most 120 characters');
const title = z.string().trim().max(120, 'Use at most 120 characters').nullable();
const optionalId = z.uuid('Invalid id').nullable();
const instructions = z.string().max(8000, 'Use at most 8,000 characters');
const email = z.email('Enter a valid email address').max(254);
const concurrency = z
  .number({ error: 'Enter a number' })
  .int('Use a whole number')
  .min(1, 'At least 1')
  .max(10, 'At most 10');
const openTasks = z
  .number({ error: 'Enter a number' })
  .int('Use a whole number')
  .min(1, 'At least 1')
  .max(50, 'At most 50');

const hireBody = z.object({
  display_name: name,
  role_key: z.string().min(1, 'Choose a role').max(64),
  title: title.default(null),
  org_unit_id: optionalId.default(null),
  manager_id: optionalId.default(null),
  instructions: instructions.default(''),
  max_concurrency: concurrency.optional(),
  // Empty string means "enter it later".
  email: z
    .union([z.literal(''), email])
    .nullable()
    .default(null),
});

const updateBody = z
  .object({
    display_name: name.optional(),
    title: title.optional(),
    org_unit_id: optionalId.optional(),
    manager_id: optionalId.optional(),
    instructions: instructions.optional(),
    max_concurrency: concurrency.optional(),
    max_open_tasks: openTasks.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const listQuery = z.object({
  status: z.enum(AI_STATES).optional(),
  org_unit_id: z.uuid().optional(),
});

/** Hiring and lifecycle of AI employees (Phase 1, slice 3). */
export function registerEmployeeRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db } = deps;

  app.get('/v1/role-templates', async (request) => {
    await requireMember(request, db);
    return { templates: ROLE_TEMPLATES.map(roleTemplateDto) };
  });

  app.get('/v1/employees', async (request) => {
    const { ctx } = await requireMember(request, db);
    const query = listQuery.parse(request.query);
    const rows = await withTenant(db, ctx.orgId, (trx) =>
      listEmployees(trx, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.org_unit_id ? { orgUnitId: query.org_unit_id } : {}),
      }),
    );
    return { employees: rows.map(employeeDto) };
  });

  app.post('/v1/employees', async (request, reply) => {
    const { member, ctx } = await requireMember(request, db);
    const body = hireBody.parse(request.body);
    const row = await withTenant(db, ctx.orgId, async (trx) => {
      const hired = await hireEmployee(trx, ctx, member, {
        displayName: body.display_name,
        roleKey: body.role_key,
        title: body.title,
        orgUnitId: body.org_unit_id,
        managerId: body.manager_id,
        instructions: body.instructions,
        ...(body.max_concurrency !== undefined ? { maxConcurrency: body.max_concurrency } : {}),
        email: body.email || null,
      });
      return getEmployee(trx, hired.id);
    });
    request.log.info(
      { employee_id: row.id, role_key: row.role_key, state: row.status },
      'ai employee hired',
    );
    return reply.status(201).send({ employee: employeeDto(row) });
  });

  app.get('/v1/employees/:id', async (request) => {
    const { ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const [row, identities, chatSub] = await withTenant(db, ctx.orgId, (trx) =>
      Promise.all([
        getEmployee(trx, id),
        listIdentities(trx, id),
        trx
          .selectFrom('conversations.chat_subscriptions')
          .select(['state', 'expire_time', 'last_event_at', 'last_error'])
          .where('employee_id', '=', id)
          .where('state', '<>', 'deleted')
          .orderBy('created_at', 'desc')
          .executeTakeFirst(),
      ]),
    );
    const template = findRoleTemplate(row.role_key);
    return {
      employee: employeeDto(row),
      template: template ? roleTemplateDto(template) : null,
      onboarding: onboardingChecklist(row, template),
      identities: identities.map(identityDto),
      google_configured: Boolean(deps.google),
      chat: {
        configured: Boolean(deps.google?.scopes?.some((s) => s.includes('/auth/chat.'))),
        subscription: chatSub
          ? {
              state: chatSub.state,
              expire_time: chatSub.expire_time ? new Date(chatSub.expire_time).toISOString() : null,
              last_event_at: chatSub.last_event_at
                ? new Date(chatSub.last_event_at).toISOString()
                : null,
              last_error: chatSub.last_error,
            }
          : null,
      },
    };
  });

  app.patch('/v1/employees/:id', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = updateBody.parse(request.body);
    const row = await withTenant(db, ctx.orgId, async (trx) => {
      await updateEmployee(trx, ctx, member, id, {
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.org_unit_id !== undefined ? { orgUnitId: body.org_unit_id } : {}),
        ...(body.manager_id !== undefined ? { managerId: body.manager_id } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.max_concurrency !== undefined ? { maxConcurrency: body.max_concurrency } : {}),
        ...(body.max_open_tasks !== undefined ? { maxOpenTasks: body.max_open_tasks } : {}),
      });
      return getEmployee(trx, id);
    });
    request.log.info({ employee_id: id, fields: Object.keys(body) }, 'ai employee updated');
    return { employee: employeeDto(row) };
  });

  app.put('/v1/employees/:id/company-email', async (request) => {
    const { member, ctx } = await requireMember(request, db);
    const { id } = idParam.parse(request.params);
    const body = z.object({ email }).parse(request.body);
    const row = await withTenant(db, ctx.orgId, async (trx) => {
      await setCompanyEmail(trx, ctx, member, id, body.email);
      return getEmployee(trx, id);
    });
    request.log.info({ employee_id: id, state: row.status }, 'ai employee company email set');
    return { employee: employeeDto(row) };
  });

  const lifecycle = {
    suspend: suspendEmployee,
    resume: resumeEmployee,
    terminate: terminateEmployee,
  } as const;
  for (const [action, run] of Object.entries(lifecycle)) {
    app.post(`/v1/employees/:id/${action}`, async (request) => {
      const { member, ctx } = await requireMember(request, db);
      const { id } = idParam.parse(request.params);
      const { row, tokens } = await withTenant(db, ctx.orgId, async (trx) => {
        const before = await getEmployee(trx, id);
        await run(trx, ctx, member, id);
        // Termination disconnects its accounts and revokes their tokens at Google.
        const revoked =
          action === 'terminate' && before.status !== 'terminated'
            ? await disconnectIdentities(trx, ctx, deps, id, 'terminated')
            : [];
        return { row: await getEmployee(trx, id), tokens: revoked };
      });
      for (const token of tokens) {
        await revokeQuietly(deps, request.log, token, { employee_id: id, reason: 'terminated' });
      }
      request.log.info(
        { employee_id: id, action, state: row.status },
        'ai employee lifecycle action',
      );
      return { employee: employeeDto(row) };
    });
  }
}
