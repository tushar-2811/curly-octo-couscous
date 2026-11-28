import {
  asApp,
  sql,
  withTenant,
  type Database,
  type GmailMailbox,
  type Kysely,
  type OutboundMessage,
} from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { recordInbound } from '../messages';
import {
  automatedReason,
  buildReplyMime,
  extractBody,
  headerMap,
  decodeWords,
  OUTBOUND_HEADER,
  parseAddressList,
  stripQuoted,
} from './email';
import { GoogleApiError } from './errors';
import type { GoogleWorkspace, PulledMessage } from './workspace';

/**
 * Gmail for AI employees (Phase 2). Each employee's inbox is watched: Gmail publishes a
 * small "something changed" notification (email address + history id) to the same Pub/Sub
 * topic as Chat. The worker then reads the inbox history from where it last stopped, stores
 * each new email once and starts its MessageWorkflow. Replies go to the sender, in the same
 * thread, exactly once.
 */

/** Renew the watch once a day (it lasts 7 days). */
const RENEW_WHEN_LEFT_MS = 6 * 24 * 60 * 60 * 1000;
/** Emails read when the stored history is too old to continue from. */
const CATCH_UP_MAX = 25;
/** Labels whose messages are never answered. */
const SKIP_LABELS = ['SENT', 'DRAFT', 'SPAM', 'TRASH'];

export interface GmailDeps {
  db: Kysely<Database>;
  google: GoogleWorkspace;
  logger: Logger;
  /** projects/P/topics/T */
  topic: string;
}

type Auth = { orgId: string; employeeId: string };

/** AI employees whose Google account granted Gmail reading (all organizations). */
export async function gmailEmployees(db: Kysely<Database>): Promise<Auth[]> {
  return asApp(db, async (trx) => {
    const r = await sql<{ org_id: string; employee_id: string }>`
      select org_id, employee_id from app.gmail_employees()
    `.execute(trx);
    return r.rows.map((x) => ({ orgId: x.org_id, employeeId: x.employee_id }));
  });
}

async function mailboxOwner(db: Kysely<Database>, email: string): Promise<Auth | null> {
  return asApp(db, async (trx) => {
    const r = await sql<{ org_id: string; employee_id: string }>`
      select org_id, employee_id from app.gmail_mailbox_owner(${email})
    `.execute(trx);
    const row = r.rows[0];
    return row ? { orgId: row.org_id, employeeId: row.employee_id } : null;
  });
}

function loadMailbox(deps: GmailDeps, auth: Auth): Promise<GmailMailbox | undefined> {
  return withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .selectFrom('conversations.gmail_mailboxes')
      .selectAll()
      .where('employee_id', '=', auth.employeeId)
      .executeTakeFirst(),
  );
}

/**
 * Make sure Gmail is publishing the employee's inbox changes: start the watch, or renew it
 * once a day. A watch on a different account than before (re-linked) starts afresh.
 */
export async function ensureGmailWatch(
  deps: GmailDeps,
  auth: Auth,
): Promise<{ action: 'kept' | 'renewed' | 'created' | 'restarted'; email: string }> {
  const [stored, linked] = await Promise.all([loadMailbox(deps, auth), linkedAt(deps, auth)]);
  const expires = stored?.watch_expiration ? new Date(stored.watch_expiration).getTime() : 0;
  // Linking again revokes the old token, which can end the old watch: start a new one.
  const relinked = Boolean(
    stored?.watched_at && linked && new Date(stored.watched_at).getTime() < linked.getTime(),
  );
  if (stored && !relinked && expires - Date.now() > RENEW_WHEN_LEFT_MS) {
    return { action: 'kept', email: stored.email_address };
  }
  const [profile, watch] = await Promise.all([
    deps.google.gmailProfile(auth),
    deps.google.gmailWatch(auth, deps.topic),
  ]);
  const email = profile.emailAddress.toLowerCase();
  const expiration = new Date(Number(watch.expiration));
  const sameAccount = stored?.email_address.toLowerCase() === email;
  const action = !stored ? 'created' : sameAccount ? 'renewed' : 'restarted';
  const now = new Date();
  // A new account: also read mail that arrived after it was linked but before this watch.
  const backfillAfter = action === 'renewed' ? null : new Date((linked ?? now).getTime() - 60_000);
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .insertInto('conversations.gmail_mailboxes')
      .values({
        org_id: auth.orgId,
        employee_id: auth.employeeId,
        email_address: email,
        history_id: watch.historyId,
        watch_expiration: expiration,
        watched_at: now,
        backfill_after: backfillAfter,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('employee_id').doUpdateSet({
          email_address: email,
          // Keep reading from where we stopped, unless this is another account.
          history_id: sameAccount
            ? sql<string>`coalesce(conversations.gmail_mailboxes.history_id, ${watch.historyId}::bigint)`
            : watch.historyId,
          watch_expiration: expiration,
          watched_at: now,
          ...(backfillAfter ? { backfill_after: backfillAfter } : {}),
          last_error: null,
          updated_at: now,
        }),
      )
      .execute(),
  );
  deps.logger.info(
    { employee_id: auth.employeeId, action, expires: expiration.toISOString() },
    'gmail watch updated',
  );
  return { action, email };
}

/** When the employee's current Google account was linked. */
async function linkedAt(deps: GmailDeps, auth: Auth): Promise<Date | null> {
  const identity = await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .selectFrom('workforce.external_identities')
      .select('connected_at')
      .where('member_id', '=', auth.employeeId)
      .where('provider', '=', 'google_workspace')
      .where('connection_status', '=', 'connected')
      .orderBy('connected_at', 'desc')
      .executeTakeFirst(),
  );
  return identity?.connected_at ? new Date(identity.connected_at) : null;
}

/** Record a failed watch or sync on the mailbox, for the dashboard. */
export async function noteMailboxError(
  deps: GmailDeps,
  auth: Auth,
  message: string,
): Promise<void> {
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .updateTable('conversations.gmail_mailboxes')
      .set({ last_error: message.slice(0, 2000), updated_at: new Date() })
      .where('employee_id', '=', auth.employeeId)
      .execute(),
  );
}

/**
 * Store one email for the employee. Returns the stored message id to process, or null when
 * there is nothing to do: its own mail, automated mail, deleted, or already decided.
 */
export async function ingestEmail(
  deps: GmailDeps,
  auth: Auth,
  gmailId: string,
  selfEmail: string,
): Promise<string | null> {
  const log = deps.logger.child({ employee_id: auth.employeeId, gmail_message: gmailId });
  let message;
  try {
    message = await deps.google.gmailMessage(auth, gmailId);
  } catch (err) {
    if (err instanceof GoogleApiError && err.code === 'not_found') return null;
    throw err;
  }
  const labels = message.labelIds ?? [];
  const skipLabel = SKIP_LABELS.find((l) => labels.includes(l));
  if (skipLabel) {
    log.debug({ label: skipLabel }, 'email skipped by label');
    return null;
  }
  const headers = headerMap(message.payload);
  const from = parseAddressList(headers.get('from'))[0] ?? null;
  if (from?.email === selfEmail.toLowerCase()) return null;
  const automated = automatedReason(headers, from);
  if (automated) {
    log.info({ reason: automated }, 'ignoring automated email');
    return null;
  }
  const subjectRaw = headers.get('subject');
  const subject = subjectRaw ? decodeWords(subjectRaw).trim().slice(0, 1000) || null : null;
  const to = parseAddressList(headers.get('to')).map((a) => a.email);
  const cc = parseAddressList(headers.get('cc')).map((a) => a.email);
  const dateHeader = headers.get('date');
  const sentAt = message.internalDate
    ? new Date(Number(message.internalDate))
    : dateHeader && !Number.isNaN(Date.parse(dateHeader))
      ? new Date(dateHeader)
      : new Date();
  const recorded = await withTenant(deps.db, auth.orgId, (trx) =>
    recordInbound(trx, {
      orgId: auth.orgId,
      employeeId: auth.employeeId,
      source: 'gmail',
      externalId: message.id,
      // The Gmail thread is the conversation, and where the reply goes.
      threadKey: message.threadId,
      replyThread: message.threadId,
      spaceName: null,
      spaceDisplayName: null,
      spaceType: 'email',
      senderEmail: from?.email ?? null,
      senderName: from?.name ?? null,
      subject,
      body: stripQuoted(extractBody(message.payload)),
      mentions: [],
      to,
      cc,
      sentAt,
      emailMessageId: headers.get('message-id')?.trim() ?? null,
      emailReferences: headers.get('references')?.trim() ?? null,
    }),
  );
  log.info(
    {
      message_id: recorded.message.id,
      duplicate: recorded.duplicate,
      to: to.length,
      cc: cc.length,
      addressed: to.includes(selfEmail.toLowerCase())
        ? 'to'
        : cc.includes(selfEmail.toLowerCase())
          ? 'cc'
          : 'other',
      sender_known: recorded.message.sender_member_id !== null,
    },
    recorded.duplicate ? 'email already stored' : 'email received',
  );
  if (recorded.duplicate && recorded.message.status === 'decided') return null;
  return recorded.message.id;
}

/** One sync per employee at a time in this process; a request during a sync runs after it. */
const syncing = new Map<string, Promise<unknown>>();

/**
 * Read the inbox history from where it last stopped and store each new email. The stored
 * position only moves forward after every email in the batch is stored, so a failure
 * re-reads them next time (storing is idempotent).
 */
export function syncMailbox(
  deps: GmailDeps,
  auth: Auth,
): Promise<{ messageIds: string[]; read: number }> {
  const previous = syncing.get(auth.employeeId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => runSync(deps, auth));
  syncing.set(auth.employeeId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (syncing.get(auth.employeeId) === next) syncing.delete(auth.employeeId);
    });
  return next;
}

async function runSync(
  deps: GmailDeps,
  auth: Auth,
): Promise<{ messageIds: string[]; read: number }> {
  const log = deps.logger.child({ employee_id: auth.employeeId });
  let mailbox = await loadMailbox(deps, auth);
  if (!mailbox?.history_id) {
    await ensureGmailWatch(deps, auth);
    mailbox = await loadMailbox(deps, auth);
  }
  if (!mailbox?.history_id) return { messageIds: [], read: 0 };
  const ids: string[] = [];
  let latest = mailbox.history_id;
  try {
    let pageToken: string | undefined;
    do {
      const page = await deps.google.gmailHistory(auth, mailbox.history_id, pageToken);
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (!ids.includes(added.message.id)) ids.push(added.message.id);
        }
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.code === 'not_found')) throw err;
    // Gmail keeps about a week of history. Read recent inbox mail instead, then go on.
    const [recent, profile] = await Promise.all([
      deps.google.gmailSearchInbox(auth, 'newer_than:2d', CATCH_UP_MAX),
      deps.google.gmailProfile(auth),
    ]);
    log.warn(
      { stored_history: mailbox.history_id, recent: recent.length },
      'gmail history too old; catching up from recent inbox mail',
    );
    ids.push(...recent.map((m) => m.id).reverse());
    latest = profile.historyId;
  }
  if (mailbox.backfill_after) {
    const since = Math.floor(new Date(mailbox.backfill_after).getTime() / 1000);
    const missed = await deps.google.gmailSearchInbox(auth, `after:${since}`, CATCH_UP_MAX);
    const fresh = missed.map((m) => m.id).filter((id) => !ids.includes(id));
    if (fresh.length > 0) {
      log.info(
        { since: new Date(since * 1000).toISOString(), emails: fresh.length },
        'reading email from since the account was linked',
      );
    }
    ids.unshift(...fresh.reverse());
  }
  const stored: string[] = [];
  for (const id of ids) {
    const messageId = await ingestEmail(deps, auth, id, mailbox.email_address);
    if (messageId) stored.push(messageId);
  }
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .updateTable('conversations.gmail_mailboxes')
      .set({
        history_id: sql<string>`greatest(history_id, ${latest}::bigint)`,
        backfill_after: null,
        last_synced_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      })
      .where('employee_id', '=', auth.employeeId)
      .execute(),
  );
  if (ids.length > 0) log.info({ read: ids.length, stored: stored.length }, 'gmail inbox synced');
  return { messageIds: stored, read: ids.length };
}

/** Whether a pulled Pub/Sub message is a Gmail notification (Chat events carry ce-type). */
export function gmailNotification(
  pulled: PulledMessage,
): { emailAddress: string; historyId: string } | null {
  if (pulled.message.attributes?.['ce-type'] || !pulled.message.data) return null;
  try {
    const d = JSON.parse(Buffer.from(pulled.message.data, 'base64').toString('utf8')) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    if (typeof d.emailAddress !== 'string') return null;
    return { emailAddress: d.emailAddress, historyId: String(d.historyId ?? '') };
  } catch {
    return null;
  }
}

/**
 * Handle one Gmail notification: sync that mailbox. Returns the stored messages to process.
 * Throws for failures worth retrying (the notification is then delivered again).
 */
export async function handleGmailEvent(
  deps: GmailDeps,
  note: { emailAddress: string; historyId: string },
): Promise<{ auth: Auth | null; messageIds: string[] }> {
  const auth = await mailboxOwner(deps.db, note.emailAddress);
  if (!auth) {
    deps.logger.warn(
      { history_id: note.historyId },
      'gmail notification for an unknown mailbox; dropping it',
    );
    return { auth: null, messageIds: [] };
  }
  await withTenant(deps.db, auth.orgId, (trx) =>
    trx
      .updateTable('conversations.gmail_mailboxes')
      .set({ last_event_at: new Date() })
      .where('employee_id', '=', auth.employeeId)
      .execute(),
  );
  try {
    const { messageIds } = await syncMailbox(deps, auth);
    return { auth, messageIds };
  } catch (err) {
    await noteMailboxError(deps, auth, err instanceof Error ? err.message : String(err)).catch(
      () => undefined,
    );
    throw err;
  }
}

/** The inbound fields an email reply needs. */
export interface EmailReplyTarget {
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  reply_thread: string | null;
  email_message_id: string | null;
  email_references: string | null;
}

/**
 * Send a reply by email as the employee, to the sender, in the same thread. Gmail has no
 * request id, so before sending it looks in the thread for a message carrying this reply's
 * id (sent by an earlier attempt that failed before it was recorded).
 */
export async function sendEmailReply(
  deps: { google: GoogleWorkspace; logger: Logger },
  auth: Auth,
  reply: OutboundMessage,
  target: EmailReplyTarget,
): Promise<{ externalId: string; alreadySent: boolean }> {
  if (!target.sender_email) {
    throw new GoogleApiError('bad_request', 'Gmail: the email has no sender to reply to');
  }
  if (target.reply_thread) {
    const thread = await deps.google.gmailThreadHeaders(auth, target.reply_thread, OUTBOUND_HEADER);
    const earlier = thread.find((m) =>
      (m.payload?.headers ?? []).some(
        (h) =>
          h.name.toLowerCase() === OUTBOUND_HEADER.toLowerCase() && h.value.trim() === reply.id,
      ),
    );
    if (earlier) return { externalId: earlier.id, alreadySent: true };
  }
  const mime = buildReplyMime({
    to: { name: target.sender_name, email: target.sender_email },
    subject: target.subject,
    inReplyTo: target.email_message_id,
    references: target.email_references,
    body: reply.body,
    outboundId: reply.id,
  });
  const sent = await deps.google.gmailSend(
    auth,
    Buffer.from(mime, 'utf8').toString('base64url'),
    target.reply_thread,
  );
  return { externalId: sent.id, alreadySent: false };
}
