/**
 * OnboardingWorkflow: one per AI employee, id `onboarding-<memberId>` (Identity
 * linking §2). The web process starts it with signalWithStart when the Google account
 * is linked. Runs inside Temporal's deterministic sandbox: side effects are activities.
 *
 * Phase 1 handles the identity step. Integration checks, environment images and
 * activation join as later slices add them.
 */
import { condition, defineSignal, log, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities } from '../activities';

const { continueOnboarding } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '2 seconds', maximumInterval: '1 minute', maximumAttempts: 10 },
});

export const identityLinkedSignal = defineSignal('identityLinked');
export const identityDisconnectedSignal = defineSignal('identityDisconnected');

export interface OnboardingInput {
  orgId: string;
  memberId: string;
}

type OnboardingEvent = 'identity_linked' | 'identity_disconnected';

/** With nothing to do for this long, the workflow ends; the next link starts a new one. */
const IDLE_TIMEOUT = '7 days';

export async function onboardingWorkflow(input: OnboardingInput): Promise<string> {
  const events: OnboardingEvent[] = [];
  setHandler(identityLinkedSignal, () => void events.push('identity_linked'));
  setHandler(identityDisconnectedSignal, () => void events.push('identity_disconnected'));
  log.info('onboarding workflow started', { employee_id: input.memberId });

  let state = 'unknown';
  for (;;) {
    const woke = await condition(() => events.length > 0, IDLE_TIMEOUT);
    if (!woke) {
      log.info('onboarding workflow idle; ending', { employee_id: input.memberId, state });
      return state;
    }
    const event = events.shift()!;
    if (event === 'identity_linked') {
      state = await continueOnboarding(input);
      log.info('identity step done', { employee_id: input.memberId, state });
    } else {
      // The web process already moved the employee back; wait for a new link.
      log.info('identity disconnected; waiting for a new link', { employee_id: input.memberId });
      state = 'external_identity_pending';
    }
  }
}
