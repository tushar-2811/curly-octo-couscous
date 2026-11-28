import { describe, expect, it } from 'vitest';
import type { Classification } from './classification';
import { reconcile } from './classifier';
import { decide } from './decide';
import { computeFacts, nameAppears, type AddressingFacts } from './facts';

const nova = {
  memberId: 'm1',
  displayName: 'Nova',
  emails: ['nova@acme.test'],
  chatUserIds: ['users/42'],
};
const ctx = { orgDomain: 'acme.test', senderIsMember: true, inMyThread: false };
const base = {
  source: 'google_chat' as const,
  spaceType: 'space' as const,
  senderEmail: 'mia@acme.test',
  body: 'hello',
  subject: null,
  mentions: [],
  to: [],
  cc: [],
};

const facts = (over: Partial<AddressingFacts> = {}): AddressingFacts => ({
  explicitly_mentioned: false,
  direct_message: false,
  recipient_role: null,
  name_in_text: false,
  in_my_thread: false,
  sender_is_member: true,
  sender_in_domain: true,
  from_self: false,
  ...over,
});

const cls = (over: Partial<Classification> = {}): Classification => ({
  intent: 'question',
  addressed_to_me: 'explicit_mention',
  should_respond: true,
  urgency: 'later',
  needs: ['memory'],
  references: { jira_keys: [], repos: [], people: [], urls: [] },
  summary: 'Asks something',
  confidence: 0.9,
  reason: 'Direct question',
  ...over,
});

describe('addressing facts', () => {
  it('finds mentions by Chat id or email, any case', () => {
    expect(computeFacts({ ...base, mentions: ['users/42'] }, nova, ctx).explicitly_mentioned).toBe(
      true,
    );
    expect(
      computeFacts({ ...base, mentions: ['NOVA@acme.test'] }, nova, ctx).explicitly_mentioned,
    ).toBe(true);
    expect(computeFacts({ ...base, mentions: ['users/7'] }, nova, ctx).explicitly_mentioned).toBe(
      false,
    );
  });

  it('knows direct messages, email recipients and its own messages', () => {
    expect(computeFacts({ ...base, spaceType: 'direct' }, nova, ctx).direct_message).toBe(true);
    const mail = { ...base, source: 'gmail' as const, spaceType: 'email' as const };
    expect(computeFacts({ ...mail, to: ['nova@acme.test'] }, nova, ctx).recipient_role).toBe('to');
    expect(computeFacts({ ...mail, cc: ['nova@acme.test'] }, nova, ctx).recipient_role).toBe('cc');
    expect(computeFacts(mail, nova, ctx).recipient_role).toBe('not_listed');
    expect(computeFacts(base, nova, ctx).recipient_role).toBeNull();
    expect(computeFacts({ ...base, senderEmail: 'Nova@acme.test' }, nova, ctx).from_self).toBe(
      true,
    );
  });

  it('checks the sender domain, including subdomains', () => {
    expect(computeFacts(base, nova, ctx).sender_in_domain).toBe(true);
    expect(
      computeFacts({ ...base, senderEmail: 'a@eu.acme.test' }, nova, ctx).sender_in_domain,
    ).toBe(true);
    expect(
      computeFacts({ ...base, senderEmail: 'a@notacme.test' }, nova, ctx).sender_in_domain,
    ).toBe(false);
    expect(computeFacts({ ...base, senderEmail: null }, nova, ctx).sender_in_domain).toBe(false);
  });

  it('matches the name only as a whole word', () => {
    expect(nameAppears('Nova', 'Hi Nova, can you check?')).toBe(true);
    expect(nameAppears('Nova', 'ask @nova')).toBe(true);
    expect(nameAppears('Nova', 'Novak is out today')).toBe(false);
    expect(nameAppears('C', 'C is a language')).toBe(false);
  });
});

describe('reconciling the classifier with the facts', () => {
  it('trusts the facts over the model', () => {
    const missed = reconcile(
      cls({ addressed_to_me: 'implicit' }),
      facts({ explicitly_mentioned: true }),
    );
    expect(missed.classification.addressed_to_me).toBe('explicit_mention');
    expect(missed.corrections).toHaveLength(1);
    const invented = reconcile(cls({ addressed_to_me: 'explicit_mention' }), facts());
    expect(invented.classification.addressed_to_me).toBe('implicit');
    expect(reconcile(cls(), facts({ explicitly_mentioned: true })).corrections).toEqual([]);
    // Email: in To is direct; only in Cc is not.
    const emailed = reconcile(
      cls({ addressed_to_me: 'direct_message' }),
      facts({ recipient_role: 'to' }),
    );
    expect(emailed.corrections).toEqual([]);
    expect(
      reconcile(cls({ addressed_to_me: 'direct_message' }), facts({ recipient_role: 'cc' }))
        .classification.addressed_to_me,
    ).toBe('implicit');
  });
});

describe('decision rules', () => {
  it('ignores its own messages and declines outsiders who write to it', () => {
    expect(decide(facts({ from_self: true }), cls()).action).toBe('ignore');
    const outsider = facts({ sender_is_member: false, sender_in_domain: false });
    expect(decide({ ...outsider, direct_message: true }, cls()).action).toBe('decline');
    expect(decide(outsider, cls()).action).toBe('ignore');
  });

  it('stays quiet when the message is not for it, but remembers it', () => {
    expect(decide(facts(), cls({ addressed_to_me: 'not_addressed' })).action).toBe('remember');
    expect(decide(facts(), cls({ addressed_to_me: 'implicit', confidence: 0.4 })).action).toBe(
      'remember',
    );
    expect(
      decide(facts(), cls({ addressed_to_me: 'implicit', should_respond: false })).action,
    ).toBe('remember');
    expect(decide(facts(), cls({ addressed_to_me: 'implicit' })).action).toBe('reply');
  });

  it('answers questions with the sources they need', () => {
    const d = decide(facts({ explicitly_mentioned: true }), cls({ needs: ['jira', 'memory'] }));
    expect(d).toMatchObject({ action: 'reply', needs: ['jira', 'memory'], ackFirst: true });
    const plain = decide(facts({ direct_message: true }), cls({ needs: [] }));
    expect(plain).toMatchObject({ action: 'reply', needs: ['memory'], ackFirst: false });
    const code = decide(facts({ direct_message: true }), cls({ needs: ['code'] }));
    expect(code.reasons[1]).toMatch(/Phase 3/);
  });

  it('acknowledges work, remembers FYIs, clarifies guesses', () => {
    const mention = facts({ explicitly_mentioned: true });
    expect(decide(mention, cls({ intent: 'work_request' })).action).toBe('acknowledge');
    expect(decide(mention, cls({ intent: 'fyi' })).action).toBe('remember');
    expect(decide(mention, cls({ intent: 'social' })).action).toBe('reply');
    expect(decide(mention, cls({ confidence: 0.3 })).reasons[0]).toMatch(/clarify/);
    expect(decide(mention, cls({ intent: 'unclear' })).reasons[0]).toMatch(/clarify/);
  });

  it('asks the sender to clarify, never a person, when it could not classify a message', () => {
    const unsure = decide(facts({ direct_message: true }), null);
    expect(unsure.action).toBe('reply');
    expect(unsure.reasons[0]).toMatch(/clarify/);
    expect(decide(facts(), null).action).toBe('remember');
  });
});
