import { Writable } from 'node:stream';
import { createDb, createMigrator, sql, withTenant, type Member } from '@aiw/db';
import { LlmError, recordInbound, type StructuredLlm, type StructuredRequest } from '@aiw/engine';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { hireEmployee, registerOrganization } from '@aiw/workforce';
import { ApplicationFailure } from '@temporalio/common';
import type { Client } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActivities } from './activities';
import { sweepMessages } from './sweep';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

class FakeLlm implements StructuredLlm {
  readonly model = 'fake';
  down = false;
  async generate(request: StructuredRequest) {
    if (this.down) throw new LlmError('unavailable', 'down');
    const out =
      request.name === 'chat_reply'
        ? { reply: 'Hello!', answered: 'yes', used_sources: [] }
        : {
            intent: 'social',
            addressed_to_me: 'direct_message',
            should_respond: true,
            urgency: 'none',
            needs: [],
            references: { jira_keys: [], repos: [], people: [], urls: [] },
            summary: 'Says hi',
            confidence: 0.9,
            reason: 'Greeting',
          };
    return {
      text: JSON.stringify(out),
      model: 'fake',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  }
}

describe.skipIf(!url)('message processing in the worker', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `worker-${run}.test`;
  const llm = new FakeLlm();
  const activities = createActivities({ logger: silent, db, llm, embedder: null });
  let admin: Member;
  let nova: Member;
  let ctx: ActorContext;
  let n = 0;

  const receive = () =>
    withTenant(db, ctx.orgId, (trx) =>
      recordInbound(trx, {
        orgId: ctx.orgId,
        employeeId: nova.id,
        source: 'simulated',
        externalId: `w-${run}-${++n}`,
        threadKey: null,
        spaceName: null,
        spaceType: 'direct',
        senderEmail: `owner@${domain}`,
        senderName: 'Owner',
        subject: null,
        body: 'Hi Nova',
        mentions: [],
        to: [],
        cc: [],
        sentAt: new Date(),
      }),
    ).then((r) => r.message);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:worker-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Worker Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
    nova = await withTenant(db, ctx.orgId, (trx) =>
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
  });
  afterAll(() => db.destroy());

  it('processes a message and is safe to run twice', async () => {
    const m = await receive();
    const first = await activities.processInboundMessage({ orgId: ctx.orgId, messageId: m.id });
    expect(first).toMatchObject({
      action: 'reply',
      status: 'decided',
      replies: 1,
      alreadyDecided: false,
    });
    const again = await activities.processInboundMessage({ orgId: ctx.orgId, messageId: m.id });
    expect(again).toMatchObject({ action: 'reply', replies: 1, alreadyDecided: true });
  });

  it('asks Temporal to retry when the model is down, and not when the message is missing', async () => {
    const m = await receive();
    llm.down = true;
    const err = await activities
      .processInboundMessage({ orgId: ctx.orgId, messageId: m.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: 'MessageRetry', nonRetryable: false });
    llm.down = false;
    const retried = await activities.processInboundMessage({ orgId: ctx.orgId, messageId: m.id });
    expect(retried.status).toBe('decided');

    const missing = await activities
      .processInboundMessage({
        orgId: ctx.orgId,
        messageId: '00000000-0000-7000-8000-000000000000',
      })
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({ type: 'Engine:not_found', nonRetryable: true });
  });

  it('sweeps messages that never got a workflow', async () => {
    const m = await receive();
    // Pretend the web process stopped before starting its workflow, 5 minutes ago.
    await db
      .updateTable('conversations.inbound_messages')
      .set({ received_at: sql<Date>`now() - interval '5 minutes'` })
      .where('id', '=', m.id)
      .execute();
    const started: string[] = [];
    const client = {
      workflow: {
        start: async (_name: string, opts: { workflowId: string }) => {
          started.push(opts.workflowId);
          return {};
        },
      },
    } as unknown as Client;
    const count = await sweepMessages({ db, client, taskQueue: 'wf', logger: silent });
    expect(count).toBeGreaterThanOrEqual(1);
    expect(started).toContain(`message-${m.id}`);
  });
});
