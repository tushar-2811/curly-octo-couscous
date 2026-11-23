import type { AiState, Member, SuspensionReason, Tx } from '@aiw/db';
import { recordChange, type ActorContext } from '@aiw/platform';
import { WorkforceError } from './errors';

/**
 * The AI employee state machine (Identity linking §2). Every change of state goes
 * through `transition`, which refuses moves the diagram does not allow and writes
 * MemberStateChanged (old state, new state, reason) with an audit row.
 */
export const AI_TRANSITIONS: Record<AiState, readonly AiState[]> = {
  draft: ['external_identity_pending', 'terminated'],
  external_identity_pending: ['external_identity_pending', 'identity_connected', 'terminated'],
  identity_connected: ['integrations_pending'],
  integrations_pending: ['permissions_configured', 'onboarding_failed'],
  permissions_configured: ['environment_ready', 'onboarding_failed'],
  environment_ready: ['active', 'onboarding_failed'],
  onboarding_failed: ['integrations_pending', 'terminated'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'external_identity_pending', 'terminated'],
  terminated: [],
};

/** States in which the employee is still being onboarded (no work allowed). */
export const ONBOARDING_STATES: readonly AiState[] = [
  'draft',
  'external_identity_pending',
  'identity_connected',
  'integrations_pending',
  'permissions_configured',
  'environment_ready',
  'onboarding_failed',
];

export function canTransition(from: AiState, to: AiState): boolean {
  return AI_TRANSITIONS[from].includes(to);
}

export interface TransitionOptions {
  reason: string;
  suspensionReason?: SuspensionReason;
  lastError?: string;
}

export async function transition(
  trx: Tx,
  ctx: ActorContext,
  member: Member,
  to: AiState,
  options: TransitionOptions,
): Promise<Member> {
  if (member.type !== 'ai') {
    throw new WorkforceError('invalid_state', 'Only AI employees have a lifecycle');
  }
  const from = member.status as AiState;
  if (!canTransition(from, to)) {
    throw new WorkforceError('invalid_state', `An employee in "${from}" can’t move to "${to}"`);
  }
  const after = await trx
    .updateTable('workforce.members')
    .set({
      status: to,
      suspension_reason: to === 'suspended' ? (options.suspensionReason ?? 'manual') : null,
      last_error: to === 'onboarding_failed' ? (options.lastError ?? null) : null,
      updated_at: new Date(),
    })
    .where('id', '=', member.id)
    // Optimistic guard: a concurrent change of state makes this update match nothing.
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
  if (!after) {
    throw new WorkforceError(
      'invalid_state',
      'This employee’s state just changed; reload and try again',
    );
  }
  await recordChange(
    trx,
    ctx,
    {
      action: 'member.state_changed',
      resourceType: 'member',
      resourceId: member.id,
      details: {
        from,
        to,
        reason: options.reason,
        ...(after.suspension_reason ? { suspension_reason: after.suspension_reason } : {}),
      },
    },
    {
      type: 'MemberStateChanged',
      aggregateType: 'member',
      aggregateId: member.id,
      data: { from, to, reason: options.reason },
    },
  );
  return after;
}
