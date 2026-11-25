import type { AiProfile, AiState, Member, Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';
import { isUniqueViolation, requireAdmin } from './guards';
import { ONBOARDING_STATES, transition } from './lifecycle';
import { getOrganization } from './organizations';
import { checkUnit, memberRowsQuery, setLineManager, updateMember, type MemberRow } from './people';
import { findRoleTemplate, INTEGRATION_LABELS, type RoleTemplate } from './role-templates';

export interface EmployeeRow extends MemberRow {
  role_key: string;
  instructions: string;
  max_concurrency: number;
  max_open_tasks: number;
}

function employeeRowsQuery(trx: Tx) {
  return memberRowsQuery(trx)
    .innerJoin('workforce.ai_profiles as p', 'p.member_id', 'm.id')
    .select(['p.role_key', 'p.instructions', 'p.max_concurrency', 'p.max_open_tasks'])
    .where('m.type', '=', 'ai');
}

export async function listEmployees(
  trx: Tx,
  filter: { status?: AiState; orgUnitId?: string } = {},
): Promise<EmployeeRow[]> {
  let query = employeeRowsQuery(trx);
  if (filter.status) query = query.where('m.status', '=', filter.status);
  if (filter.orgUnitId) query = query.where('m.org_unit_id', '=', filter.orgUnitId);
  return (await query.orderBy('m.display_name').execute()) as EmployeeRow[];
}

export async function getEmployee(trx: Tx, id: string): Promise<EmployeeRow> {
  const row = await employeeRowsQuery(trx).where('m.id', '=', id).executeTakeFirst();
  if (!row) throw new WorkforceError('not_found', 'AI employee not found');
  return row as EmployeeRow;
}

async function loadAiMember(trx: Tx, id: string): Promise<Member> {
  const member = await trx
    .selectFrom('workforce.members')
    .selectAll()
    .where('id', '=', id)
    .where('type', '=', 'ai')
    .executeTakeFirst();
  if (!member) throw new WorkforceError('not_found', 'AI employee not found');
  return member;
}

/**
 * The employee's Google account must be on the company's domain (or a subdomain): the
 * company creates it in its own Google Admin console (Identity linking, decision).
 */
async function checkCompanyEmail(trx: Tx, ctx: ActorContext, email: string, exceptId?: string) {
  const org = await getOrganization(trx, ctx.orgId);
  const domain = email.split('@')[1] ?? '';
  if (domain !== org.domain && !domain.endsWith(`.${org.domain}`)) {
    throw new WorkforceError(
      'email_domain',
      `Use an account on your company domain (@${org.domain})`,
      'email',
    );
  }
  let query = trx.selectFrom('workforce.members').select('id').where('email', '=', email);
  if (exceptId) query = query.where('id', '<>', exceptId);
  if (await query.executeTakeFirst()) {
    throw new WorkforceError(
      'email_taken',
      'This email already belongs to someone in your organization',
      'email',
    );
  }
}

export interface HireInput {
  displayName: string;
  roleKey: string;
  title: string | null;
  orgUnitId: string | null;
  managerId: string | null;
  instructions: string;
  maxConcurrency?: number;
  /** The company-created Google account; can also be entered later. */
  email?: string | null;
}

/**
 * Hire an AI employee from a role template (FR-EMP-1). The employee starts in draft;
 * entering its company email moves it to external_identity_pending.
 */
export async function hireEmployee(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  input: HireInput,
): Promise<Member> {
  requireAdmin(actor);
  const template = findRoleTemplate(input.roleKey);
  if (!template) throw new WorkforceError('unknown_template', 'Choose a role', 'role_key');
  await checkUnit(trx, input.orgUnitId);
  const email = input.email?.trim().toLowerCase() || null;
  if (email) await checkCompanyEmail(trx, ctx, email);

  const member = await trx
    .insertInto('workforce.members')
    .values({
      org_id: ctx.orgId,
      type: 'ai',
      display_name: input.displayName.trim(),
      title: input.title?.trim() || template.defaultTitle,
      org_unit_id: input.orgUnitId,
      status: 'draft',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const profile = await trx
    .insertInto('workforce.ai_profiles')
    .values({
      member_id: member.id,
      org_id: ctx.orgId,
      role_key: template.key,
      instructions: input.instructions.trim(),
      capabilities: JSON.stringify(template.capabilities),
      max_concurrency: input.maxConcurrency ?? template.defaults.maxConcurrency,
      max_open_tasks: template.defaults.maxOpenTasks,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(
    trx,
    ctx,
    {
      action: 'member.hired',
      resourceType: 'member',
      resourceId: member.id,
      details: {
        type: 'ai',
        role_key: template.key,
        display_name: member.display_name,
        title: member.title,
        org_unit_id: member.org_unit_id,
        max_concurrency: profile.max_concurrency,
      },
    },
    {
      type: 'MemberHired',
      aggregateType: 'member',
      aggregateId: member.id,
      data: { type: 'ai', role_key: template.key },
    },
  );
  if (input.managerId) await setLineManager(trx, ctx, actor, member.id, input.managerId);
  if (email) return setCompanyEmail(trx, ctx, actor, member.id, email);
  return member;
}

/**
 * Record the company-created Google account the employee will use. Allowed until the
 * account is linked; the first time, the employee moves to external_identity_pending.
 */
export async function setCompanyEmail(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
  rawEmail: string,
): Promise<Member> {
  requireAdmin(actor);
  const member = await loadAiMember(trx, id);
  if (member.status !== 'draft' && member.status !== 'external_identity_pending') {
    throw new WorkforceError(
      'invalid_state',
      'The company account can only be changed before it is linked',
      'email',
    );
  }
  const email = rawEmail.trim().toLowerCase();
  if (email === member.email) return member;
  await checkCompanyEmail(trx, ctx, email, id);
  let updated: Member;
  try {
    updated = await trx
      .updateTable('workforce.members')
      .set({ email, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err, 'members_org_email_uq')) {
      throw new WorkforceError(
        'email_taken',
        'This email already belongs to someone in your organization',
        'email',
      );
    }
    throw err;
  }
  await recordChange(trx, ctx, {
    action: 'member.company_email_set',
    resourceType: 'member',
    resourceId: id,
    details: { before: member.email, after: email },
  });
  return updated.status === 'draft'
    ? transition(trx, ctx, updated, 'external_identity_pending', {
        reason: 'company_email_entered',
      })
    : updated;
}

export interface EmployeePatch {
  displayName?: string;
  title?: string | null;
  orgUnitId?: string | null;
  managerId?: string | null;
  instructions?: string;
  maxConcurrency?: number;
  maxOpenTasks?: number;
}

/** Edit an AI employee's profile, placement and working limits. Admins only. */
export async function updateEmployee(
  trx: Tx,
  ctx: ActorContext,
  actor: Member,
  id: string,
  patch: EmployeePatch,
): Promise<void> {
  requireAdmin(actor);
  const member = await loadAiMember(trx, id);
  if (member.status === 'terminated') {
    throw new WorkforceError('invalid_state', 'A terminated employee can’t be changed');
  }
  const memberPatch = {
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.orgUnitId !== undefined ? { orgUnitId: patch.orgUnitId } : {}),
  };
  if (Object.keys(memberPatch).length > 0) await updateMember(trx, ctx, actor, id, memberPatch);
  if (patch.managerId !== undefined) await setLineManager(trx, ctx, actor, id, patch.managerId);

  const profilePatch = {
    ...(patch.instructions !== undefined ? { instructions: patch.instructions.trim() } : {}),
    ...(patch.maxConcurrency !== undefined ? { max_concurrency: patch.maxConcurrency } : {}),
    ...(patch.maxOpenTasks !== undefined ? { max_open_tasks: patch.maxOpenTasks } : {}),
  };
  if (Object.keys(profilePatch).length === 0) return;
  const before = await trx
    .selectFrom('workforce.ai_profiles')
    .selectAll()
    .where('member_id', '=', id)
    .executeTakeFirstOrThrow();
  const after = await trx
    .updateTable('workforce.ai_profiles')
    .set({ ...profilePatch, updated_at: new Date() })
    .where('member_id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const pick = (p: AiProfile) => ({
    instructions: p.instructions,
    max_concurrency: p.max_concurrency,
    max_open_tasks: p.max_open_tasks,
  });
  await recordChange(
    trx,
    ctx,
    {
      action: 'ai_profile.updated',
      resourceType: 'member',
      resourceId: id,
      details: { before: pick(before), after: pick(after) },
    },
    {
      type: 'AiProfileUpdated',
      aggregateType: 'member',
      aggregateId: id,
      data: { fields: Object.keys(profilePatch) },
    },
  );
}

/** Manually suspend an active employee: no new work; running work pauses. */
export async function suspendEmployee(trx: Tx, ctx: ActorContext, actor: Member, id: string) {
  requireAdmin(actor);
  const member = await loadAiMember(trx, id);
  if (member.status !== 'active') {
    throw new WorkforceError('invalid_state', 'Only an active employee can be suspended');
  }
  return transition(trx, ctx, member, 'suspended', {
    reason: 'manual',
    suspensionReason: 'manual',
  });
}

/** Resume a manually suspended employee. Other causes must be fixed and re-verified. */
export async function resumeEmployee(trx: Tx, ctx: ActorContext, actor: Member, id: string) {
  requireAdmin(actor);
  const member = await loadAiMember(trx, id);
  if (member.status !== 'suspended') {
    throw new WorkforceError('invalid_state', 'Only a suspended employee can be resumed');
  }
  if (member.suspension_reason !== 'manual') {
    throw new WorkforceError(
      'invalid_state',
      'This employee was suspended automatically; it resumes once the cause is fixed',
    );
  }
  return transition(trx, ctx, member, 'active', { reason: 'manual_resume' });
}

/** Permanently end an employee. Cannot be undone; history is kept. */
export async function terminateEmployee(trx: Tx, ctx: ActorContext, actor: Member, id: string) {
  requireAdmin(actor);
  const member = await loadAiMember(trx, id);
  if (member.status === 'terminated') return member;
  return transition(trx, ctx, member, 'terminated', { reason: 'manual' });
}

export type CheckStatus = 'passed' | 'pending' | 'failed';

export interface OnboardingCheck {
  key: string;
  label: string;
  status: CheckStatus;
  required: boolean;
  detail: string;
}

const PRE_IDENTITY: readonly string[] = ['draft', 'external_identity_pending'];

/**
 * Onboarding checklist for steps 1–4 (Architecture refinement §E), derived from the
 * employee's current data. Tool connections arrive in Phase 2, so those checks stay
 * pending until then; the grants check comes from the Access module.
 */
export function onboardingChecklist(
  employee: EmployeeRow,
  template: RoleTemplate | undefined,
  grants: { passed: boolean; detail: string } = {
    passed: false,
    detail: 'No repositories, projects or spaces granted yet',
  },
) {
  const state = employee.status as AiState;
  const identityDone = !PRE_IDENTITY.includes(state) && state !== 'terminated';
  const checks: OnboardingCheck[] = [
    {
      key: 'profile',
      label: 'Profile created',
      status: 'passed',
      required: true,
      detail: template ? `Hired as ${template.name}` : `Role ${employee.role_key}`,
    },
    {
      key: 'identity',
      label: INTEGRATION_LABELS.google_workspace,
      status: identityDone ? 'passed' : 'pending',
      required: true,
      detail: identityDone
        ? `Linked: ${employee.email ?? ''}`
        : employee.email
          ? `Waiting for ${employee.email} to be linked with Google sign-in`
          : 'Enter the Google account your company created for this employee',
    },
    ...(template?.integrations ?? []).map((i): OnboardingCheck => ({
      key: i.key,
      label: INTEGRATION_LABELS[i.key],
      status: 'pending',
      required: i.required,
      detail: 'Not connected yet',
    })),
    {
      key: 'team',
      label: 'Department or team',
      status: employee.org_unit_id ? 'passed' : 'pending',
      required: true,
      detail: employee.org_unit_name ?? 'Not assigned',
    },
    {
      key: 'manager',
      label: 'Manager',
      status: employee.manager_id ? 'passed' : 'pending',
      required: true,
      detail: employee.manager_name ?? 'Not assigned',
    },
    {
      key: 'grants',
      label: 'Access grants',
      status: grants.passed ? 'passed' : 'pending',
      required: true,
      detail: grants.detail,
    },
  ];
  if (state === 'onboarding_failed') {
    checks.push({
      key: 'error',
      label: 'Last error',
      status: 'failed',
      required: true,
      detail: employee.last_error ?? 'A step failed',
    });
  }
  return {
    state,
    onboarding: ONBOARDING_STATES.includes(state),
    checks,
  };
}
