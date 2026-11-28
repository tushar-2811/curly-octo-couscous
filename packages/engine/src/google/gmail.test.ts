import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import { SecretBox, storeSecret, type ActorContext } from '@aiw/platform';
import { hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendQueuedReplies } from './delivery';
import {
  ensureGmailWatch,
  gmailEmployees,
  gmailNotification,
  handleGmailEvent,
  type GmailDeps,
} from './gmail';
import { GoogleTokenBroker } from './token-broker';
import { GoogleWorkspace, type GmailMessage } from './workspace';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A fake of the Gmail endpoints we call. */
class FakeGmail {
  calls: { method: string; url: string; body: unknown }[] = [];
  email = '';
  profileHistory = '500';
  historyGone = false;
  added: string[] = [];
  mail = new Map<string, GmailMessage>();
  threads = new Map<string, GmailMessage[]>();
  sent = 0;
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
    this.calls.push({ method, url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(200, { access_token: 'at', expires_in: 3600, scope: 'x' });
    }
    const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
    if (!url.startsWith(gmail)) return json(500, { error: { message: `unexpected ${url}` } });
    const path = url.slice(gmail.length);
    if (path === '/profile') {
      return json(200, { emailAddress: this.email, historyId: this.profileHistory });
    }
    if (path === '/watch') {
      return json(200, { historyId: '100', expiration: String(Date.now() + 7 * 864e5) });
    }
    if (path.startsWith('/history?')) {
      if (this.historyGone)
        return json(404, { error: { message: 'Requested entity was not found.' } });
      const ids = this.added.splice(0);
      return json(200, {
        history: ids.map((id) => ({
          messagesAdded: [{ message: { id, threadId: this.mail.get(id)?.threadId ?? 't' } }],
        })),
        historyId: '105',
      });
    }
    if (path.startsWith('/messages?')) {
      return json(200, {
        messages: [...this.mail.values()].map((m) => ({ id: m.id, threadId: m.threadId })),
      });
    }
    if (path === '/messages/send') {
      this.sent++;
      return json(200, {
        id: `sent-${this.sent}`,
        threadId: (body as { threadId?: string }).threadId,
      });
    }
    const thread = /^\/threads\/([^?]+)\?/.exec(path);
    if (thread)
      return json(200, { messages: this.threads.get(decodeURIComponent(thread[1]!)) ?? [] });
    const msg = /^\/messages\/([^?]+)\?format=full/.exec(path);
    if (msg) {
      const m = this.mail.get(decodeURIComponent(msg[1]!));
      return m ? json(200, m) : json(404, { error: { message: 'not found' } });
    }
    return json(500, { error: { message: `unexpected ${url}` } });
  };
}

function email(
  id: string,
  threadId: string,
  h: Record<string, string>,
  text: string,
  labelIds = ['INBOX', 'UNREAD'],
): GmailMessage {
  return {
    id,
    threadId,
    labelIds,
    internalDate: String(Date.parse('2026-11-28T10:00:00Z')),
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(h).map(([name, value]) => ({ name, value })),
      body: { data: b64(text) },
    },
  };
}

describe('gmail notifications', () => {
  it('tells Gmail notifications from Chat events', () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: 'a@co.test', historyId: 9 })).toString(
      'base64',
    );
    expect(gmailNotification({ ackId: 'x', message: { messageId: '1', data } })).toEqual({
      emailAddress: 'a@co.test',
      historyId: '9',
    });
    expect(
      gmailNotification({
        ackId: 'x',
        message: { messageId: '1', data, attributes: { 'ce-type': 'google.workspace.chat.x' } },
      }),
    ).toBeNull();
    expect(
      gmailNotification({ ackId: 'x', message: { messageId: '1', data: 'bm9wZQ==' } }),
    ).toBeNull();
  });
});

describe.skipIf(!url)('gmail', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `gmail-${run}.test`;
  const secrets = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  const fake = new FakeGmail();
  let admin: Member;
  let nova: Member;
  let ctx: ActorContext;
  let google: GoogleWorkspace;
  let deps: GmailDeps;
  const note = () => ({ emailAddress: `Nova@${domain}`, historyId: '105' });

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:gmail-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Gmail Co',
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
    fake.email = `nova@${domain}`;
    await withTenant(db, ctx.orgId, async (trx) => {
      const ref = await storeSecret(trx, secrets, ctx.orgId, 'google_refresh_token', 'rt-1');
      await trx
        .insertInto('workforce.external_identities')
        .values({
          org_id: ctx.orgId,
          member_id: nova.id,
          provider: 'google_workspace',
          provider_user_id: `g${run}`,
          email_address: `nova@${domain}`,
          hosted_domain: domain,
          granted_scopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
          ],
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
    });
    const broker = new GoogleTokenBroker({
      db,
      secrets,
      clientId: 'c',
      clientSecret: 's',
      logger: silent,
      fetch: fake.fetch,
    });
    google = new GoogleWorkspace(broker, silent, fake.fetch);
    deps = { db, google, logger: silent, topic: 'projects/p/topics/t' };
  });
  afterAll(() => db.destroy());

  const mailbox = () =>
    withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.gmail_mailboxes')
        .selectAll()
        .where('employee_id', '=', nova.id)
        .executeTakeFirstOrThrow(),
    );

  it('starts watching the inbox once, and lists the employee', async () => {
    expect((await gmailEmployees(db)).some((e) => e.employeeId === nova.id)).toBe(true);
    expect(await ensureGmailWatch(deps, { orgId: ctx.orgId, employeeId: nova.id })).toMatchObject({
      action: 'created',
      email: `nova@${domain}`,
    });
    const watch = fake.calls.find((c) => c.url.endsWith('/watch'))!;
    expect(watch.body).toEqual({
      topicName: 'projects/p/topics/t',
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    });
    const box = await mailbox();
    expect(box).toMatchObject({ history_id: '100', last_error: null });
    // A new account: mail since it was linked is read on the next sync.
    expect(box.backfill_after).not.toBeNull();
    // Fresh watch: nothing to do until it nears expiry.
    expect((await ensureGmailWatch(deps, { orgId: ctx.orgId, employeeId: nova.id })).action).toBe(
      'kept',
    );
  });

  it('stores a person’s email once, threaded, and skips automated and own mail', async () => {
    fake.mail.set(
      'g1',
      email(
        'g1',
        'T1',
        {
          From: `"Mia Wong" <Mia@${domain}>`,
          To: `Nova <nova@${domain}>`,
          Cc: `raj@${domain}`,
          Subject: '=?UTF-8?B?UmVsZWFzZSDinJM=?=',
          'Message-ID': '<m2@mail.test>',
          References: '<m1@mail.test>',
        },
        'Can you check PF-7?\n\nOn Thu, 27 Nov 2026, Raj <raj@x> wrote:\n> earlier',
      ),
    );
    fake.mail.set(
      'g2',
      email('g2', 'T2', { From: 'news@vendor.test', 'List-Unsubscribe': '<x>' }, 'Sale!'),
    );
    fake.mail.set('g3', email('g3', 'T1', { From: `nova@${domain}` }, 'mine', ['SENT']));
    fake.added.push('g1', 'g2', 'g3');

    const r = await handleGmailEvent(deps, note());
    expect(r.auth).toEqual({ orgId: ctx.orgId, employeeId: nova.id });
    expect(r.messageIds).toHaveLength(1);
    const stored = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.inbound_messages')
        .selectAll()
        .where('id', '=', r.messageIds[0]!)
        .executeTakeFirstOrThrow(),
    );
    expect(stored).toMatchObject({
      source: 'gmail',
      external_id: 'g1',
      thread_key: 'T1',
      reply_thread: 'T1',
      space_type: 'email',
      sender_email: `mia@${domain}`,
      sender_name: 'Mia Wong',
      subject: 'Release ✓',
      body: 'Can you check PF-7?',
      to_addresses: [`nova@${domain}`],
      cc_addresses: [`raj@${domain}`],
      email_message_id: '<m2@mail.test>',
      email_references: '<m1@mail.test>',
      conversation_key: 'thread:T1',
    });
    const box = await mailbox();
    expect(box.history_id).toBe('105');
    expect(box.last_event_at).not.toBeNull();
    const search = fake.calls.find((c) => c.url.includes('/messages?q='))!;
    expect(decodeURIComponent(search.url)).toMatch(/q=in:inbox\+after:\d+/);
    expect(box.backfill_after).toBeNull();
  });

  it('starts a new watch when the account is linked again', async () => {
    await withTenant(db, ctx.orgId, (trx) =>
      trx
        .updateTable('workforce.external_identities')
        .set({ connected_at: new Date(Date.now() + 1000) })
        .where('member_id', '=', nova.id)
        .execute(),
    );
    expect((await ensureGmailWatch(deps, { orgId: ctx.orgId, employeeId: nova.id })).action).toBe(
      'renewed',
    );
    // Same account: keeps reading from where it stopped.
    expect((await mailbox()).history_id).toBe('105');
  });

  it('catches up from recent mail when the stored history is too old', async () => {
    fake.historyGone = true;
    fake.profileHistory = '900';
    const r = await handleGmailEvent(deps, note());
    // g1 is stored but not yet decided, so it is handed back to process.
    expect(r.messageIds).toHaveLength(1);
    expect((await mailbox()).history_id).toBe('900');
    fake.historyGone = false;
  });

  it('drops notifications for a mailbox nobody owns', async () => {
    expect(
      await handleGmailEvent(deps, { emailAddress: 'stranger@else.test', historyId: '1' }),
    ).toEqual({ auth: null, messageIds: [] });
  });

  async function queueReply(body: string): Promise<{ inboundId: string; replyId: string }> {
    return withTenant(db, ctx.orgId, async (trx) => {
      const inbound = await trx
        .selectFrom('conversations.inbound_messages')
        .select('id')
        .where('employee_id', '=', nova.id)
        .where('external_id', '=', 'g1')
        .executeTakeFirstOrThrow();
      const reply = await trx
        .insertInto('conversations.outbound_messages')
        .values({
          org_id: ctx.orgId,
          employee_id: nova.id,
          in_reply_to: inbound.id,
          kind: 'reply',
          body,
          status: 'queued',
          answered: 'yes',
          sources: '[]',
          model: null,
          latency_ms: null,
          input_tokens: null,
          output_tokens: null,
          error_code: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { inboundId: inbound.id, replyId: reply.id };
    });
  }

  it('replies to the sender in the same thread', async () => {
    const { inboundId, replyId } = await queueReply('Hi Mia,\nPF-7 is in review.\n\nNova');
    expect(await sendQueuedReplies({ db, google, logger: silent }, ctx.orgId, inboundId)).toEqual({
      sent: 1,
      failed: 0,
    });
    const send = fake.calls.find((c) => c.url.endsWith('/messages/send'))!;
    const { raw, threadId } = send.body as { raw: string; threadId: string };
    expect(threadId).toBe('T1');
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    expect(mime).toContain(`To: "Mia Wong" <mia@${domain}>`);
    expect(mime).toContain('In-Reply-To: <m2@mail.test>');
    expect(mime).toContain('References: <m1@mail.test> <m2@mail.test>');
    expect(mime).toContain(`X-AIW-Outbound-Id: ${replyId}`);
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    const reply = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.outbound_messages')
        .select(['status', 'external_id'])
        .where('id', '=', replyId)
        .executeTakeFirstOrThrow(),
    );
    expect(reply).toEqual({ status: 'sent', external_id: 'sent-1' });
  });

  it('does not send twice when an earlier attempt already reached the thread', async () => {
    const { inboundId, replyId } = await queueReply('Second answer');
    fake.threads.set('T1', [
      {
        id: 'already-there',
        threadId: 'T1',
        payload: { headers: [{ name: 'X-AIW-Outbound-Id', value: replyId }] },
      },
    ]);
    const before = fake.sent;
    expect(await sendQueuedReplies({ db, google, logger: silent }, ctx.orgId, inboundId)).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(fake.sent).toBe(before);
    const reply = await withTenant(db, ctx.orgId, (trx) =>
      trx
        .selectFrom('conversations.outbound_messages')
        .select(['status', 'external_id'])
        .where('id', '=', replyId)
        .executeTakeFirstOrThrow(),
    );
    expect(reply).toEqual({ status: 'sent', external_id: 'already-there' });
  });
});
