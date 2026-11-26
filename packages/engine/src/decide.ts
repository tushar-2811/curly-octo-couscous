import type { DecisionAction } from '@aiw/db';
import type { Classification, Need } from './classification';
import { directlyAddressed, type AddressingFacts } from './facts';

export interface Decision {
  action: DecisionAction;
  /** Plain sentences, shown in the inbox and logs. The first one is the main reason. */
  reasons: string[];
  /** Sources to read before answering. */
  needs: Need[];
  /** Post a short "Looking into it…" first, because the answer needs slow lookups. */
  ackFirst: boolean;
}

export interface DecisionPolicy {
  /** Below this the classification is treated as a guess. */
  confidenceFloor: number;
}

export const DEFAULT_POLICY: DecisionPolicy = { confidenceFloor: 0.6 };

const decision = (action: DecisionAction, reason: string, needs: Need[] = []): Decision => ({
  action,
  reasons: [reason],
  needs,
  ackFirst: false,
});

/**
 * What the employee does with a message (Phase 2 plan, step 4). Plain rules over the facts
 * and the classification, so every outcome can be explained and tested. `classification` is
 * null when the classifier failed or is switched off.
 */
export function decide(
  facts: AddressingFacts,
  c: Classification | null,
  policy: DecisionPolicy = DEFAULT_POLICY,
): Decision {
  if (facts.from_self) return decision('ignore', "It is the employee's own message");

  const direct = directlyAddressed(facts);
  if (!facts.sender_is_member && !facts.sender_in_domain) {
    return direct
      ? decision('decline', 'The sender is outside the organization')
      : decision('ignore', 'From outside the organization and not addressed to the employee');
  }

  if (!c) {
    return direct || facts.name_in_text
      ? decision('needs_review', 'The message could not be classified; a person should check it')
      : decision('remember', 'The message could not be classified; kept for memory only');
  }

  const guess = c.confidence < policy.confidenceFloor;
  if (!direct) {
    if (c.addressed_to_me === 'not_addressed') {
      return decision('remember', 'Not meant for the employee; kept for memory');
    }
    if (guess || !c.should_respond) {
      return decision('remember', 'Not clearly meant for the employee; kept for memory');
    }
  }

  if (guess || c.intent === 'unclear') {
    return decision('reply', 'Unclear what is wanted; asking the sender to clarify');
  }

  switch (c.intent) {
    case 'social':
      return c.should_respond
        ? decision('reply', 'A short social reply')
        : decision('remember', 'Small talk; no reply needed');
    case 'fyi':
      return decision('remember', 'Information only; kept in memory');
    case 'feedback':
      return decision('reply', 'Feedback on earlier work; acknowledging it', ['memory']);
    case 'work_request':
      return decision(
        'acknowledge',
        'A work request: acknowledged and recorded (doing the work comes in Phase 3)',
        c.needs,
      );
    case 'question':
    case 'status_check': {
      const needs: Need[] = c.needs.length > 0 ? c.needs : ['memory'];
      const reasons = [
        c.intent === 'question' ? 'A question to answer' : 'A status check to answer',
      ];
      if (needs.includes('code')) {
        reasons.push('Reading code comes in Phase 3; answering from memory and Jira for now');
      }
      return {
        action: 'reply',
        reasons,
        needs,
        ackFirst: needs.includes('jira') || needs.includes('code'),
      };
    }
  }
}
