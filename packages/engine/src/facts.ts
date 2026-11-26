/**
 * Addressing facts (Phase 2 plan, step 2). These are exact, so code works them out from
 * the message and the directory; the model never guesses them. The classifier receives
 * them as input and its answer is reconciled against them.
 */
export interface EmployeeAddress {
  memberId: string;
  displayName: string;
  /** Every address the employee receives at (its company Google account). */
  emails: string[];
  /** Google Chat user resource names, e.g. "users/1234". */
  chatUserIds: string[];
}

export type RecipientRole = 'to' | 'cc' | 'not_listed';

export interface AddressingFacts {
  /** @mentioned in Chat (by user id or email). */
  explicitly_mentioned: boolean;
  /** A one-to-one Chat conversation with the employee. */
  direct_message: boolean;
  /** Email only: where the employee's address appears. Null for Chat. */
  recipient_role: RecipientRole | null;
  /** The employee's name appears in the text without an @mention. */
  name_in_text: boolean;
  /** The employee already took part in this thread. */
  in_my_thread: boolean;
  /** The sender is a person or AI employee of this organization. */
  sender_is_member: boolean;
  /** The sender's address is on the organization's domain (or a subdomain). */
  sender_in_domain: boolean;
  /** Sent by the employee itself (an echo of its own reply). */
  from_self: boolean;
}

export interface FactsInput {
  source: 'google_chat' | 'gmail' | 'simulated';
  spaceType: 'direct' | 'group' | 'space' | 'email' | null;
  senderEmail: string | null;
  body: string;
  subject: string | null;
  mentions: string[];
  to: string[];
  cc: string[];
}

const lower = (v: string) => v.trim().toLowerCase();

function inDomain(email: string | null, domain: string): boolean {
  if (!email) return false;
  const host = lower(email).split('@')[1] ?? '';
  const d = lower(domain);
  return host === d || host.endsWith(`.${d}`);
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The name as a whole word, so "Nova" matches "Hi Nova," but not "Novak". */
export function nameAppears(name: string, text: string): boolean {
  const n = name.trim();
  if (n.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${escapeRegExp(n)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

export function computeFacts(
  message: FactsInput,
  employee: EmployeeAddress,
  context: { orgDomain: string; senderIsMember: boolean; inMyThread: boolean },
): AddressingFacts {
  const myIds = new Set([...employee.emails, ...employee.chatUserIds].map(lower));
  const isMe = (v: string) => myIds.has(lower(v));
  const isEmail = message.source === 'gmail' || message.spaceType === 'email';
  const recipient_role: RecipientRole | null = !isEmail
    ? null
    : message.to.some(isMe)
      ? 'to'
      : message.cc.some(isMe)
        ? 'cc'
        : 'not_listed';
  return {
    explicitly_mentioned: message.mentions.some(isMe),
    direct_message: !isEmail && message.spaceType === 'direct',
    recipient_role,
    name_in_text: nameAppears(employee.displayName, `${message.subject ?? ''}\n${message.body}`),
    in_my_thread: context.inMyThread,
    sender_is_member: context.senderIsMember,
    sender_in_domain: inDomain(message.senderEmail, context.orgDomain),
    from_self: message.senderEmail !== null && isMe(message.senderEmail),
  };
}

/** Facts alone say the message is for the employee, whatever the model thinks. */
export function directlyAddressed(f: AddressingFacts): boolean {
  return f.explicitly_mentioned || f.direct_message || f.recipient_role === 'to';
}
