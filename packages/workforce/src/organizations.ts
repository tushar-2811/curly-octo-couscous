import { randomBytes } from 'node:crypto';
import {
  memberForSubject,
  newId,
  withTenant,
  type Database,
  type Kysely,
  type Member,
  type Organization,
  type Tx,
} from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';

/** Personal email providers can't be a company's Google Workspace domain. */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

export function validateOrgDomain(domain: string): void {
  if (!DOMAIN.test(domain)) {
    throw new WorkforceError(
      'domain_not_allowed',
      'Enter a valid domain, like example.com',
      'domain',
    );
  }
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    throw new WorkforceError(
      'domain_not_allowed',
      'Use your company’s own domain, not a personal email provider',
      'domain',
    );
  }
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 2 ? base : `org-${base}`.slice(0, 40);
}

export interface RegisterOrganizationInput {
  /** Stable identifier of the signed-in person from the identity provider. */
  subject: string;
  email: string;
  displayName: string;
  orgName: string;
  domain: string;
  requestId: string | null;
}

/**
 * Register a new organization with the signed-in person as its first admin.
 * Writes the org, the admin member, two audit records and an OrganizationCreated event
 * in one transaction, under row-level security for the new org id.
 */
export async function registerOrganization(
  db: Kysely<Database>,
  input: RegisterOrganizationInput,
): Promise<{ organization: Organization; member: Member }> {
  if (await memberForSubject(db, input.subject)) {
    throw new WorkforceError('already_member', 'You already belong to an organization');
  }
  const domain = normalizeDomain(input.domain);
  validateOrgDomain(domain);
  const email = input.email.trim().toLowerCase();

  const orgId = await newId(db);
  const memberId = await newId(db);
  const slug = `${slugify(input.orgName)}-${randomBytes(2).toString('hex')}`;

  try {
    return await withTenant(db, orgId, async (trx) => {
      const organization = await trx
        .insertInto('workforce.organizations')
        .values({
          id: orgId,
          name: input.orgName.trim(),
          slug,
          domain,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const member = await trx
        .insertInto('workforce.members')
        .values({
          id: memberId,
          org_id: orgId,
          type: 'human',
          display_name: input.displayName.trim(),
          email,
          person_role: 'admin',
          auth_subject: input.subject,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const ctx: ActorContext = { orgId, actorMemberId: memberId, requestId: input.requestId };
      await recordChange(
        trx,
        ctx,
        {
          action: 'organization.created',
          resourceType: 'organization',
          resourceId: orgId,
          details: { name: organization.name, domain },
        },
        {
          type: 'OrganizationCreated',
          aggregateType: 'organization',
          aggregateId: orgId,
          data: { name: organization.name, domain, admin_member_id: memberId },
        },
      );
      await recordChange(
        trx,
        ctx,
        {
          action: 'member.added',
          resourceType: 'member',
          resourceId: memberId,
          details: { type: 'human', role: 'admin', email },
        },
        {
          type: 'MemberAdded',
          aggregateType: 'member',
          aggregateId: memberId,
          data: { type: 'human', role: 'admin' },
        },
      );
      return { organization, member };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'organizations_domain_key')) {
      throw new WorkforceError(
        'domain_taken',
        'An organization with this domain is already registered',
        'domain',
      );
    }
    if (isUniqueViolation(err, 'members_auth_subject_key')) {
      throw new WorkforceError('already_member', 'You already belong to an organization');
    }
    throw err;
  }
}

export async function getOrganization(trx: Tx, orgId: string): Promise<Organization> {
  const org = await trx
    .selectFrom('workforce.organizations')
    .selectAll()
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!org) throw new WorkforceError('not_found', 'Organization not found');
  return org;
}

/** Rename the organization. Admins only; audited with before and after values. */
export async function updateOrganization(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  patch: { name: string },
): Promise<Organization> {
  if (actor.person_role !== 'admin') {
    throw new WorkforceError('forbidden', 'Only organization admins can change these settings');
  }
  const before = await getOrganization(trx, ctx.orgId);
  const name = patch.name.trim();
  if (name === before.name) return before;
  const after = await trx
    .updateTable('workforce.organizations')
    .set({ name, updated_at: new Date() })
    .where('id', '=', ctx.orgId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(
    trx,
    ctx,
    {
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: ctx.orgId,
      details: { before: { name: before.name }, after: { name } },
    },
    {
      type: 'OrganizationUpdated',
      aggregateType: 'organization',
      aggregateId: ctx.orgId,
      data: { name },
    },
  );
  return after;
}

export async function getMember(trx: Tx, memberId: string): Promise<Member> {
  const member = await trx
    .selectFrom('workforce.members')
    .selectAll()
    .where('id', '=', memberId)
    .executeTakeFirst();
  if (!member) throw new WorkforceError('not_found', 'Member not found');
  return member;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === constraint;
}
