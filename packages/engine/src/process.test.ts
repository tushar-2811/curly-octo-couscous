import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { addPerson, hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmError, type StructuredLlm, type StructuredRequest } from './llm';
import { listInbox, recordInbound, type InboundInput } from './messages';
import { processMessage } from './process';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

/** Returns whatever the test queues, and keeps the prompts it was sent. */
class FakeLlm implements StructuredLlm {
  readonly model = 'fake-model';
  readonly requests: StructuredRequest[] = [];
  next: unknown[] = [];
  async generate(request: StructuredRequest) {
    this.requests.push(request);
    const out = this.next.shift();
    if (out instanceof Error) throw out;
    return {
      text: typeof out === 'string' ? out : JSON.stringify(out),
      model: this.model,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 5,
    };
  }
}

const answer = (over: Record<string, unknown> = {}) => ({
  intent: 'question',
  addressed_to_me: 'implicit',
  should_respond: true,
  urgency: 'later',
  needs: ['jira'],
  references: { jira_keys: ['WEB-12'], repos: [], people: [], urls: [] },
  summary: 'Asks about WEB-12',
  confidence: 0.85,
  reason: 'Asks Nova directly',
  ...over,
});

describe.skipIf(!url)('processing messages', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `engine-${run}.test`;
  const llm = new FakeLlm();
  let admin: Member;
  let nova: Member;
  let ctx: ActorContext;
  let n = 0;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  const receive = (over: Partial<InboundInput> = {}) =>
    inOrg((trx) =>
      recordInbound(trx, {
        orgId: ctx.orgId,
        employeeId: nova.id,
        source: 'simulated',
        externalId: `ext-${run}-${++n}`,
        threadKey: null,
        spaceName: 'spaces/team',
        spaceType: 'space',
        senderEmail: `mia@${domain}`,
        senderName: 'Mia',
        subject: null,
        body: 'Nova, what is the status of WEB-12?',
        mentions: [],
        to: [],
        cc: [],
        sentAt: new Date(),
        ...over,
      }),
    );

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:engine-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Engine Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
    nova = await inOrg((trx) =>
      hireEmployee(trx, ctx, admin, {
        displayName: 'Nova',
        roleKey: 'frontend_engineer',
        title: null,
        orgUnitId: null,
        managerId: null,
        instructions: '',
        email: `nova@${domain}`,
      }),
    );
    await inOrg((trx) =>
      addPerson(trx, ctx, admin, {
        displayName: 'Mia',
        email: `mia@${domain}`,
        title: null,
        role: 'member',
        orgUnitId: null,
        managerId: null,
      }),
    );
  });
  afterAll(() => db.destroy());

  it('stores a delivery once', async () => {
    const first = await receive({ externalId: `dup-${run}` });
    const again = await receive({ externalId: `dup-${run}`, body: 'changed' });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({
      duplicate: true,
      message: { id: first.message.id, body: first.message.body },
    });
    expect(first.message.sender_member_id).not.toBeNull();
  });

  it('classifies, decides and saves why', async () => {
    const { message } = await receive({ mentions: [`nova@${domain}`] });
    llm.next.push(answer());
    const result = await processMessage({ db, llm, logger: silent }, ctx.orgId, message.id);
    expect(result.facts).toMatchObject({ explicitly_mentioned: true, sender_is_member: true });
    expect(result.classification?.addressed_to_me).toBe('explicit_mention');
    expect(result.corrections).toHaveLength(1);
    expect(result.decision).toMatchObject({
      action: 'reply',
      needs: ['jira'],
      model: 'fake-model',
      input_tokens: 100,
      error_code: null,
    });
    expect(result.message.status).toBe('decided');
    expect(llm.requests.at(-1)?.input).toContain('<message>\nNova, what is the status of WEB-12?');

    const again = await processMessage({ db, llm, logger: silent }, ctx.orgId, message.id);
    expect(again.alreadyDecided).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it('keeps messages for others as memory without replying', async () => {
    const { message } = await receive({ body: 'Mia, lunch at 1?' });
    llm.next.push(
      answer({
        intent: 'social',
        addressed_to_me: 'not_addressed',
        should_respond: false,
        needs: [],
      }),
    );
    const result = await processMessage({ db, llm, logger: silent }, ctx.orgId, message.id);
    expect(result.decision.action).toBe('remember');
  });

  it('declines outsiders without calling the model, and audits it', async () => {
    const before = llm.requests.length;
    const { message } = await receive({ senderEmail: 'eve@elsewhere.test', spaceType: 'direct' });
    const result = await processMessage({ db, llm, logger: silent }, ctx.orgId, message.id);
    expect(result.decision.action).toBe('decline');
    expect(llm.requests.length).toBe(before);
    const audit = await inOrg((trx) =>
      trx
        .selectFrom('platform.audit_logs')
        .select('action')
        .where('action', '=', 'message.declined')
        .execute(),
    );
    expect(audit).toHaveLength(1);
  });

  it('leaves the message to retry when the model is down, and needs review when output is bad', async () => {
    const down = await receive({ spaceType: 'direct' });
    llm.next.push(new LlmError('unavailable', 'down'));
    const failed = await processMessage({ db, llm, logger: silent }, ctx.orgId, down.message.id);
    expect(failed.decision).toMatchObject({ action: 'needs_review', error_code: 'unavailable' });
    expect(failed.message.status).toBe('failed');

    llm.next.push(answer({ addressed_to_me: 'direct_message' }));
    const retried = await processMessage({ db, llm, logger: silent }, ctx.orgId, down.message.id);
    expect(retried.decision.action).toBe('reply');
    expect(retried.message.status).toBe('decided');

    const bad = await receive({ spaceType: 'direct' });
    llm.next.push({ intent: 'gossip' });
    const invalid = await processMessage({ db, llm, logger: silent }, ctx.orgId, bad.message.id);
    expect(invalid.decision).toMatchObject({
      action: 'needs_review',
      error_code: 'invalid_output',
    });
    expect(invalid.message.status).toBe('decided');
  });

  it('works without a model configured', async () => {
    const { message } = await receive({ spaceType: 'direct' });
    const result = await processMessage({ db, llm: null, logger: silent }, ctx.orgId, message.id);
    expect(result.decision).toMatchObject({ action: 'needs_review', error_code: 'not_configured' });
  });

  it('lists the inbox newest first with decisions', async () => {
    const page = await inOrg((trx) => listInbox(trx, nova.id, { limit: 3 }));
    expect(page.entries).toHaveLength(3);
    expect(page.nextCursor).toBe(page.entries[2]!.message.id);
    expect(page.entries[0]!.decision?.action).toBe('needs_review');
    const next = await inOrg((trx) =>
      listInbox(trx, nova.id, { limit: 50, before: page.nextCursor! }),
    );
    expect(next.entries.length).toBeGreaterThan(0);
    expect(next.entries.every((e) => e.message.id < page.nextCursor!)).toBe(true);
  });
});
