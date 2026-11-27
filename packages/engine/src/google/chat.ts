import {
  asApp,
  sql,
  withTenant,
  type Database,
  type Kysely,
  type OutboundMessage,
  type SpaceType,
} from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { recordInbound } from '../messages';
import { GoogleApiError } from './errors';
import type { ChatSpace, GoogleWorkspace, PulledMessage } from './workspace';

/**
 * Google Chat for AI employees (Phase 2). One Workspace Events subscription per employee
 * covers every space it is in; Google publishes "message created" events to our Pub/Sub
 * topic; the worker pulls them, stores each message once and starts its MessageWorkflow.
 * Replies are posted as the employee, exactly once (Chat's requestId).
 */
export const ALL_SPACES = '//chat.googleapis.com/spaces/-';
export const MESSAGE_CREATED = 'google.workspace.chat.message.v1.created';
const BATCH_CREATED = 'google.workspace.chat.message.v1.batchCreated';
/** Renew a subscription this long before it expires (it lasts up to 7 days). */
const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;

export interface ChatDeps {
  db: Kysely<Database>;
  google: GoogleWorkspace;
  logger: Logger;
  /** projects/P/topics/T */
  topic: string;
  /** projects/P/subscriptions/S */
  subscription: string;
}

type Auth = { orgId: string; employeeId: string };

/** AI employees whose Google account granted Chat access (all organizations). */
export async function chatEmployees(db: Kysely<Database>): Promise<Auth[]> {
  return asApp(db, async (trx) => {
    const r = await sql<{ org_id: string; employee_id: string }>`
      select org_id, employee_id from app.chat_employees()
    `.execute(trx);
    return r.rows.map((x) => ({ orgId: x.org_id, employeeId: x.employee_id }));
  });
}

async function subscriptionOwner(db: Kysely<Database>, name: string): Promise<Auth | null> {
  return asApp(db, async (trx) => {
    const r = await sql<{ org_id: string; employee_id: string }>`
      select org_id, employee_id from app.chat_subscription_owner(${name})
    `.execute(trx);
    const row = r.rows[0];
    return row ? { orgId: row.org_id, employeeId: row.employee_id } : null;
  });
}

/**
 * Make sure the employee has a live subscription to all its spaces: reuse it, renew it when
 * it is close to expiring, reactivate it if Google suspended it, or create it.
 */
export async function ensureChatSubscription(
  deps: ChatDeps,
  auth: Auth,
): Promise<{ name: string; action: 'kept' | 'renewed' | 'reactivated' | 'created' }> {
  const log = deps.logger.child({ employee_id: auth.employeeId });
  const stored = await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .selectFrom('conversations.chat_subscriptions')
      .selectAll()
      .where('employee_id', '=', auth.employeeId)
      .where('target_resource', '=', ALL_SPACES)
      .where('state', '<>', 'deleted')
      .executeTakeFirst(),
  );
  let sub = null;
  if (stored) {
    try {
      sub = await deps.google.getSubscription(auth, stored.subscription_name);
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.code === 'not_found')) throw err;
    }
  }
  sub ??= await deps.google.findSubscription(auth, ALL_SPACES, MESSAGE_CREATED);
  let action: 'kept' | 'renewed' | 'reactivated' | 'created' = 'kept';
  if (!sub) {
    sub = await deps.google.createSubscription(auth, {
      target: ALL_SPACES,
      eventTypes: [MESSAGE_CREATED],
      topic: deps.topic,
    });
    action = 'created';
  } else if (sub.state === 'SUSPENDED') {
    await deps.google.reactivateSubscription(auth, sub.name);
    sub = await deps.google.getSubscription(auth, sub.name);
    action = 'reactivated';
  } else if (!sub.expireTime || Date.parse(sub.expireTime) - Date.now() < RENEW_BEFORE_MS) {
    await deps.google.renewSubscription(auth, sub.name);
    sub = await deps.google.getSubscription(auth, sub.name);
    action = 'renewed';
  }
  const name = sub.name;
  const expire = sub.expireTime ? new Date(sub.expireTime) : null;
  await withTenant(deps.db, auth.orgId, async (trx) => {
    if (stored && stored.subscription_name !== name) {
      await trx
        .updateTable('conversations.chat_subscriptions')
        .set({ state: 'deleted', updated_at: new Date() })
        .where('id', '=', stored.id)
        .execute();
    }
    await trx
      .insertInto('conversations.chat_subscriptions')
      .values({
        org_id: auth.orgId,
        employee_id: auth.employeeId,
        subscription_name: name,
        target_resource: ALL_SPACES,
        state: sub.state === 'SUSPENDED' ? 'suspended' : 'active',
        expire_time: expire,
        last_error: null,
      })
      .onConflict((oc) =>
        oc.column('subscription_name').doUpdateSet({
          state: sub.state === 'SUSPENDED' ? 'suspended' : 'active',
          expire_time: expire,
          last_error: null,
          updated_at: new Date(),
        }),
      )
      .execute();
  });
  if (action !== 'kept') {
    log.info(
      { subscription: name, action, expires: expire?.toISOString() },
      'chat subscription updated',
    );
  }
  return { name, action };
}

/** Record a failed keep-alive on the stored subscription, for the dashboard. */
export async function noteSubscriptionError(
  deps: ChatDeps,
  auth: Auth,
  message: string,
): Promise<void> {
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .updateTable('conversations.chat_subscriptions')
      .set({ last_error: message.slice(0, 2000), updated_at: new Date() })
      .where('employee_id', '=', auth.employeeId)
      .where('state', '<>', 'deleted')
      .execute(),
  );
}

function spaceTypeOf(space: ChatSpace): SpaceType {
  if (space.spaceType === 'DIRECT_MESSAGE') return 'direct';
  if (space.spaceType === 'GROUP_CHAT') return 'group';
  return 'space';
}

/**
 * Who sent a message. Chat includes the name and email when user auth reads it; the
 * People API is only asked when they are missing, since it returns an empty profile
 * when the Workspace turns off directory sharing.
 */
async function senderOf(
  deps: ChatDeps,
  auth: Auth,
  sender: { name: string; displayName?: string; email?: string } | undefined,
  log: Logger,
): Promise<{ name: string | null; email: string | null }> {
  const fromChat = {
    name: sender?.displayName?.trim() || null,
    email: sender?.email?.trim().toLowerCase() || null,
  };
  if (!sender?.name || (fromChat.name && fromChat.email)) return fromChat;
  const person = await deps.google.person(auth, sender.name);
  const found = { name: fromChat.name ?? person.name, email: fromChat.email ?? person.email };
  if (!found.email) {
    log.warn(
      { sender: sender.name, has_name: found.name !== null },
      'chat sender has no email; it is treated as outside the company',
    );
  }
  return found;
}

/**
 * Store one Chat message for the employee. Returns the stored message id to process, or
 * null when there is nothing to do (its own message, a bot, already stored).
 */
export async function ingestChatMessage(
  deps: ChatDeps,
  auth: Auth,
  messageName: string,
  googleUserId: string,
): Promise<string | null> {
  const log = deps.logger.child({ employee_id: auth.employeeId, chat_message: messageName });
  let message;
  try {
    message = await deps.google.getMessage(auth, messageName);
  } catch (err) {
    // Deleted before we read it: nothing to store.
    if (err instanceof GoogleApiError && err.code === 'not_found') return null;
    throw err;
  }
  const sender = message.sender?.name ?? '';
  if (sender === `users/${googleUserId}`) return null;
  if (message.sender?.type === 'BOT') {
    log.info('ignoring a message from a Chat app');
    return null;
  }
  const spaceName = message.space?.name ?? messageName.split('/messages/')[0]!;
  const [space, person] = await Promise.all([
    deps.google.getSpace(auth, spaceName),
    senderOf(deps, auth, message.sender, log),
  ]);
  const mentions = (message.annotations ?? [])
    .filter((a) => a.type === 'USER_MENTION' && a.userMention?.user?.name)
    .map((a) => a.userMention!.user!.name);
  const spaceType = spaceTypeOf(space);
  const recorded = await withTenant(deps.db, auth.orgId, (trx) =>
    recordInbound(trx, {
      orgId: auth.orgId,
      employeeId: auth.employeeId,
      source: 'google_chat',
      externalId: message.name,
      // Only real thread replies form a thread; top-level messages belong to the space.
      threadKey: message.threadReply && message.thread?.name ? message.thread.name : null,
      replyThread: spaceType === 'direct' ? null : (message.thread?.name ?? null),
      spaceName: space.name,
      spaceDisplayName: space.displayName ?? (spaceType === 'direct' ? 'Direct message' : null),
      spaceType,
      senderEmail: person.email,
      senderName: person.name,
      subject: null,
      body: message.text ?? '',
      mentions,
      to: [],
      cc: [],
      sentAt: new Date(message.createTime),
    }),
  );
  log.info(
    {
      message_id: recorded.message.id,
      duplicate: recorded.duplicate,
      space_type: spaceType,
      mentions: mentions.length,
      sender_known: recorded.message.sender_member_id !== null,
    },
    recorded.duplicate ? 'chat message already stored' : 'chat message received',
  );
  if (recorded.duplicate && recorded.message.status === 'decided') return null;
  return recorded.message.id;
}

/** The message names in one Pub/Sub event (single or batched). */
export function eventMessageNames(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as { message?: { name?: string }; messages?: { message?: { name?: string } }[] };
  if (d.message?.name) return [d.message.name];
  return (d.messages ?? []).map((m) => m.message?.name).filter((n): n is string => Boolean(n));
}

/**
 * Handle one pulled event. Returns the stored messages to process. Throws for failures
 * worth retrying (the event is then not acknowledged and Pub/Sub delivers it again).
 */
export async function handleChatEvent(
  deps: ChatDeps,
  pulled: PulledMessage,
  googleUserIdFor: (auth: Auth) => Promise<string>,
): Promise<{ auth: Auth | null; messageIds: string[]; type: string }> {
  const attrs = pulled.message.attributes ?? {};
  const type = attrs['ce-type'] ?? 'unknown';
  const source = attrs['ce-source'] ?? '';
  const subName = source.replace(/^\/\/workspaceevents\.googleapis\.com\//, '');
  const auth = subName ? await subscriptionOwner(deps.db, subName) : null;
  if (!auth) {
    deps.logger.warn({ type, source }, 'chat event for an unknown subscription; dropping it');
    return { auth: null, messageIds: [], type };
  }
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .updateTable('conversations.chat_subscriptions')
      .set({ last_event_at: new Date() })
      .where('subscription_name', '=', subName)
      .execute(),
  );
  if (type.startsWith('google.workspace.events.subscription.')) {
    // Expiring, suspended or deleted: fix it now rather than at the next keep-alive.
    deps.logger.warn({ type, employee_id: auth.employeeId }, 'chat subscription lifecycle event');
    await ensureChatSubscription(deps, auth);
    return { auth, messageIds: [], type };
  }
  if (type !== MESSAGE_CREATED && type !== BATCH_CREATED) {
    return { auth, messageIds: [], type };
  }
  const data = pulled.message.data
    ? (JSON.parse(Buffer.from(pulled.message.data, 'base64').toString('utf8')) as unknown)
    : null;
  const googleUserId = await googleUserIdFor(auth);
  const ids: string[] = [];
  for (const name of eventMessageNames(data)) {
    const id = await ingestChatMessage(deps, auth, name, googleUserId);
    if (id) ids.push(id);
  }
  return { auth, messageIds: ids, type };
}

/**
 * Post one queued reply to Chat as the employee. Safe to repeat: the reply's id is Chat's
 * requestId, so a retry returns the message already posted. Retryable failures throw;
 * others mark the reply failed.
 */
export async function sendReply(
  deps: { db: Kysely<Database>; google: GoogleWorkspace; logger: Logger },
  orgId: string,
  replyId: string,
): Promise<OutboundMessage> {
  const loaded = await withTenant(deps.db, orgId, async (trx) => {
    const reply = await trx
      .selectFrom('conversations.outbound_messages')
      .selectAll()
      .where('id', '=', replyId)
      .executeTakeFirstOrThrow();
    const inbound = await trx
      .selectFrom('conversations.inbound_messages')
      .select(['source', 'space_name', 'space_type', 'reply_thread'])
      .where('id', '=', reply.in_reply_to)
      .executeTakeFirstOrThrow();
    return { reply, inbound };
  });
  const { reply, inbound } = loaded;
  if (reply.status !== 'queued' || inbound.source !== 'google_chat' || !inbound.space_name) {
    return reply;
  }
  const auth = { orgId, employeeId: reply.employee_id };
  const started = performance.now();
  try {
    const posted = await deps.google.createMessage(auth, inbound.space_name, {
      text: reply.body,
      threadName: inbound.space_type === 'direct' ? null : inbound.reply_thread,
      requestId: reply.id,
    });
    const sent = await withTenant(deps.db, orgId, (trx) =>
      trx
        .updateTable('conversations.outbound_messages')
        .set({ status: 'sent', sent_at: new Date(), external_id: posted.name, error_code: null })
        .where('id', '=', reply.id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    deps.logger.info(
      {
        reply_id: reply.id,
        kind: reply.kind,
        chat_message: posted.name,
        send_ms: Math.round(performance.now() - started),
      },
      'reply sent to chat',
    );
    return sent;
  } catch (err) {
    const code = err instanceof GoogleApiError ? err.code : 'unknown';
    deps.logger.error({ err, reply_id: reply.id, code }, 'sending reply to chat failed');
    if (err instanceof GoogleApiError && err.retryable) throw err;
    return withTenant(deps.db, orgId, (trx) =>
      trx
        .updateTable('conversations.outbound_messages')
        .set({ status: 'failed', error_code: `chat_${code}` })
        .where('id', '=', reply.id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}

/** Send every queued reply for a message, oldest first. */
export async function sendQueuedReplies(
  deps: { db: Kysely<Database>; google: GoogleWorkspace; logger: Logger },
  orgId: string,
  messageId: string,
): Promise<{ sent: number; failed: number }> {
  const queued = await withTenant(deps.db, orgId, (trx) =>
    trx
      .selectFrom('conversations.outbound_messages')
      .select('id')
      .where('in_reply_to', '=', messageId)
      .where('status', '=', 'queued')
      .orderBy('id')
      .execute(),
  );
  let sent = 0;
  let failed = 0;
  for (const q of queued) {
    const r = await sendReply(deps, orgId, q.id);
    if (r.status === 'sent') sent++;
    else if (r.status === 'failed') failed++;
  }
  return { sent, failed };
}
