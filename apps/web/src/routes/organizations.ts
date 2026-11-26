import { withTenant } from '@aiw/db';
import { getOrganization, registerOrganization, updateOrganization } from '@aiw/workforce';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember, requireSession, setSessionCookie, type AuthDeps } from '../auth';
import { memberDto, organizationDto } from '../dto';

const createBody = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters')
    .max(120, 'Use at most 120 characters'),
  domain: z.string().trim().min(1, 'Enter your company domain').max(253),
});

const updateBody = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters')
    .max(120, 'Use at most 120 characters'),
});

export function registerOrganizationRoutes(app: FastifyInstance, deps: AuthDeps): void {
  /** Register an organization; the signed-in person becomes its first admin. */
  app.post('/v1/orgs', async (request, reply) => {
    const session = requireSession(request);
    const body = createBody.parse(request.body);
    const { organization, member } = await registerOrganization(deps.db, {
      subject: session.sub,
      email: session.email,
      displayName: session.name,
      orgName: body.name,
      domain: body.domain,
      requestId: request.id,
    });
    await setSessionCookie(reply, deps, { ...session, mid: member.id, oid: organization.id });
    request.log.info(
      { org_id: organization.id, member_id: member.id, domain: organization.domain },
      'organization registered',
    );
    return reply
      .status(201)
      .send({ organization: organizationDto(organization), member: memberDto(member) });
  });

  app.get('/v1/orgs/current', async (request) => {
    const { ctx } = await requireMember(request, deps.db);
    const organization = await withTenant(deps.db, ctx.orgId, (trx) =>
      getOrganization(trx, ctx.orgId),
    );
    return { organization: organizationDto(organization) };
  });

  app.patch('/v1/orgs/current', async (request) => {
    const { member, ctx } = await requireMember(request, deps.db);
    const body = updateBody.parse(request.body);
    const organization = await withTenant(deps.db, ctx.orgId, (trx) =>
      updateOrganization(trx, ctx, member, { name: body.name }),
    );
    request.log.info({ org_id: ctx.orgId }, 'organization updated');
    return { organization: organizationDto(organization) };
  });
}
