import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import { SecretBox, storeSecret, type ActorContext } from '@aiw/platform';
import { hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventMessageNames, handleChatEvent, sendQueuedReplies, type ChatDeps } from './chat';
import { GoogleApiError } from './errors';
import { GoogleTokenBroker } from './token-broker';
import { GoogleWorkspace } from './workspace';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe('chat event payloads', () => {
  it('reads single and batched message names', () => {
    expect(eventMessageNames({ message: { name: 'spaces/A/messages/1' } })).toEqual([
      'spaces/A/messages/1',
    ]);
    expect(
      eventMessageNames({
        messages: [{ message: { name: 'spaces/A/messages/1' } }, { message: {} }],
      }),
    ).toEqual(['spaces/A/messages/1']);
    expect(eventMessageNames(null)).toEqual([]);
  });
});

/** A fake of the Google endpoints we call, recording every request. */
class FakeGoogle {
  calls: { method: string; url: string; body: unknown }[] = [];
  refreshError: string | null = null;
  created = new Map<string, string>();
  messages = new Map<string, unknown>();
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? typeof init.body === 'string' && init.body.startsWith('{')
        ? JSON.parse(init.body)
        : String(init.body)
      : null;
    this.calls.push({ method, url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return this.refreshError
        ? json(400, { error: this.refreshError })
        : json(200, { access_token: 'at-1', expires_in: 3600, scope: 'x' });
    }
    if (url.includes('chat.googleapis.com/v1/spaces/S1/messages?')) {
      // requestId makes posting idempotent, like Chat does.
      const rid = new URL(url).searchParams.get('requestId')!;
      const name = this.created.get(rid) ?? `spaces/S1/messages/out-${this.created.size + 1}`;
      this.created.set(rid, name);
      return json(200, { name });
    }
    if (url.includes('chat.googleapis.com/v1/spaces/S1/messages/')) {
      const name = url.split('/v1/')[1]!;
      const m = this.messages.get(name);
      return m ? json(200, m) : json(404, { error: { message: 'not found' } });
    }
    if (url.endsWith('chat.googleapis.com/v1/spaces/S1')) {
      return json(200, { name: 'spaces/S1', displayName: 'Release', spaceType: 'SPACE' });
    }
    if (url.includes('people.googleapis.com/v1/people/111')) {
      return json(200, {
        names: [{ displayName: 'Mia' }],
        emailAddresses: [{ value: 'Mia@co.test' }],
      });
    }
    return json(500, { error: { message: `unexpected ${url}` } });
  };
}

describe.skipIf(!url)('google chat', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `chat-${run}.test`;
  const secrets = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  const fake = new FakeGoogle();
  let admin: Member;
  let nova: Member;
  let ctx: ActorContext;
  let broker: GoogleTokenBroker;
  let google: GoogleWorkspace;
  let deps: ChatDeps;
  const subName = `subscriptions/sub-${run}`;

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:chat-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Chat Co',
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
    await withTenant(db, ctx.orgId, async (trx) => {
      const ref = await storeSecret(trx, secrets, ctx.orgId, 'google_refresh_token', 'rt-1');
      await trx
        .insertInto('workforce.external_identities')
        .values({
          org_id: ctx.orgId,
          member_id: nova.id,
          provider: 'google_workspace',
          provider_user_id: `999${run}`,
          email_address: `nova@${domain}`,
          hosted_domain: domain,
          granted_scopes: ['https://www.googleapis.com/auth/chat.messages.readonly'],
          credential_ref: ref,
          connected_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
          last_verified_at: null,
          last_error: null,
          disconnected_at: null,
          created_by: null,
        })
        .execute();
      await trx
        .insertInto('conversations.chat_subscriptions')
        .values({
          org_id: ctx.orgId,
          employee_id: nova.id,
          subscription_name: subName,
          target_resource: '//chat.googleapis.com/spaces/-',
          expire_time: null,
          last_error: null,
        })
        .execute();
    });
    broker = new GoogleTokenBroker({
      db,
      secrets,
      clientId: 'c',
      clientSecret: 's',
      logger: silent,
      fetch: fake.fetch,
    });
    google = new GoogleWorkspace(broker, silent, fake.fetch);
    deps = {
      db,
      google,
      logger: silent,
      topic: 'projects/p/topics/t',
      subscription: 'projects/p/subscriptions/s',
    };
  });
  afterAll(() => db.destroy());

  const event = (name: string) => ({
    ackId: 'a1',
    message: {
      messageId: 'm1',
      attributes: {
        'ce-type': 'google.workspace.chat.message.v1.created',
        'ce-source': `//workspaceevents.googleapis.com/${subName}`,
      },
      data: Buffer.from(JSON.stringify({ message: { name } })).toString('base64'),
    },
  });

  it('refreshes and caches the access token', async () => {
    const a = await broker.get(ctx.orgId, nova.id);
    const b = await broker.get(ctx.orgId, nova.id);
    expect(a.token).toBe('at-1');
    expect(b).toBe(a);
    expect(fake.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    const form = String(fake.calls[0]!.body);
    expect(form).toContain('refresh_token=rt-1');
  });

  it('stores a Chat message once, with sender, space, thread and mentions', async () => {
    fake.messages.set('spaces/S1/messages/1', {
      name: 'spaces/S1/messages/1',
      text: '@Nova what is the status of PF-1?',
      createTime: '2026-11-28T10:00:00Z',
      sender: { name: 'users/111', type: 'HUMAN' },
      space: { name: 'spaces/S1' },
      thread: { name: 'spaces/S1/threads/T1' },
      threadReply: false,
      annotations: [{ type: 'USER_MENTION', userMention: { user: { name: `users/999${run}` } } }],
    });
    const uid = async () => `999${run}`;
    const r = await handleChatEvent(deps, event('spaces/S1/messages/1'), uid);
    expect(r.messageIds).toHaveLength(1);
    const stored = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.inbound_messages')
        .selectAll()
        .where('id', '=', r.messageIds[0]!)
        .executeTakeFirstOrThrow(),
    );
    expect(stored).toMatchObject({
      source: 'google_chat',
      space_name: 'spaces/S1',
      space_display_name: 'Release',
      space_type: 'space',
      thread_key: null,
      reply_thread: 'spaces/S1/threads/T1',
      sender_email: 'mia@co.test',
      sender_name: 'Mia',
      mentions: [`users/999${run}`],
      conversation_key: 'space:spaces/S1',
    });
    // Delivered again: nothing new.
    const again = await handleChatEvent(deps, event('spaces/S1/messages/1'), uid);
    expect(again.messageIds).toEqual(r.messageIds); // stored but undecided: still to process

    // Its own message is skipped.
    fake.messages.set('spaces/S1/messages/2', {
      name: 'spaces/S1/messages/2',
      text: 'Looking into it…',
      createTime: '2026-11-28T10:00:01Z',
      sender: { name: `users/999${run}`, type: 'HUMAN' },
      space: { name: 'spaces/S1' },
    });
    expect((await handleChatEvent(deps, event('spaces/S1/messages/2'), uid)).messageIds).toEqual(
      [],
    );
  });

  it('posts queued replies in the thread exactly once', async () => {
    const inbound = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.inbound_messages')
        .select('id')
        .where('external_id', '=', 'spaces/S1/messages/1')
        .executeTakeFirstOrThrow(),
    );
    await withTenant(db, ctx.orgId, (trx) =>
      trx
        .insertInto('conversations.outbound_messages')
        .values({
          org_id: ctx.orgId,
          employee_id: nova.id,
          in_reply_to: inbound.id,
          kind: 'reply',
          body: 'PF-1 is in review.',
          status: 'queued',
          answered: 'yes',
          sources: '[]',
          model: null,
          latency_ms: null,
          input_tokens: null,
          output_tokens: null,
          error_code: null,
        })
        .execute(),
    );
    const first = await sendQueuedReplies({ db, google, logger: silent }, ctx.orgId, inbound.id);
    expect(first).toEqual({ sent: 1, failed: 0 });
    const post = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/messages?'))!;
    expect(post.url).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    expect(post.body).toEqual({
      text: 'PF-1 is in review.',
      thread: { name: 'spaces/S1/threads/T1' },
    });
    // Nothing left to send.
    expect(await sendQueuedReplies({ db, google, logger: silent }, ctx.orgId, inbound.id)).toEqual({
      sent: 0,
      failed: 0,
    });
  });

  it('marks the account for reconnecting when Google refuses the refresh token', async () => {
    broker.invalidate(nova.id);
    fake.refreshError = 'invalid_grant';
    await expect(broker.get(ctx.orgId, nova.id)).rejects.toMatchObject({ code: 'reauth_required' });
    const identity = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('workforce.external_identities')
        .select(['connection_status', 'last_error'])
        .where('member_id', '=', nova.id)
        .executeTakeFirstOrThrow(),
    );
    expect(identity.connection_status).toBe('reauth_required');
    const audit = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('platform.audit_logs')
        .select('action')
        .where('action', '=', 'identity.reauth_required')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    // No more refresh attempts once marked.
    const before = fake.calls.length;
    await expect(broker.get(ctx.orgId, nova.id)).rejects.toBeInstanceOf(GoogleApiError);
    expect(fake.calls.length).toBe(before);
  });
});
