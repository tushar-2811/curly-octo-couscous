import type { Logger } from '@aiw/logger';
import { errorForStatus, GoogleApiError } from './errors';
import type { GoogleTokenBroker } from './token-broker';

/** A Chat message, as much of it as we use. */
export interface ChatMessage {
  name: string;
  text?: string;
  createTime: string;
  sender?: { name: string; type?: 'HUMAN' | 'BOT'; displayName?: string; email?: string };
  thread?: { name: string };
  threadReply?: boolean;
  space?: { name: string };
  annotations?: { type: string; userMention?: { user?: { name: string; type?: string } } }[];
}

export interface ChatSpace {
  name: string;
  displayName?: string;
  spaceType?: 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE';
}

export interface Person {
  name: string | null;
  email: string | null;
}

export interface WorkspaceSubscription {
  name: string;
  targetResource: string;
  state?: 'ACTIVE' | 'SUSPENDED' | 'DELETED' | string;
  expireTime?: string;
  suspensionReason?: string;
}

export interface PulledMessage {
  ackId: string;
  message: { data?: string; attributes?: Record<string, string>; messageId: string };
}

/** A Gmail message part (format=full). */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailHistoryPage {
  history?: {
    messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

type Auth = { orgId: string; employeeId: string };

const CHAT = 'https://chat.googleapis.com/v1';
const PEOPLE = 'https://people.googleapis.com/v1';
const EVENTS = 'https://workspaceevents.googleapis.com/v1';
const PUBSUB = 'https://pubsub.googleapis.com/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Google Workspace calls made as an AI employee (user authentication): Chat, People,
 * Workspace Events, Gmail and Pub/Sub. A 401 drops the cached token and tries once more.
 */
export class GoogleWorkspace {
  private readonly spaces = new Map<string, { space: ChatSpace; at: number }>();
  private readonly people = new Map<string, { person: Person; at: number }>();

  constructor(
    private readonly broker: GoogleTokenBroker,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    auth: Auth,
    api: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { token } = await this.broker.get(auth.orgId, auth.employeeId);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new GoogleApiError(
          timeout ? 'timeout' : 'unavailable',
          `${api}: ${timeout ? 'timed out' : 'unreachable'}`,
        );
      }
      if (res.status === 401 && attempt === 0) {
        this.broker.invalidate(auth.employeeId);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
          if (j.error?.message) detail = `${j.error.status ?? res.status} ${j.error.message}`;
        } catch {
          // Not JSON: keep the text.
        }
        throw errorForStatus(res.status, detail, api);
      }
      return (res.status === 204 ? {} : await res.json()) as T;
    }
    throw new GoogleApiError('reauth_required', `${api}: token rejected twice`);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────────

  getMessage(auth: Auth, name: string): Promise<ChatMessage> {
    return this.call(auth, 'Chat', 'GET', `${CHAT}/${name}`);
  }

  /** The space, cached for 10 minutes. */
  async getSpace(auth: Auth, name: string): Promise<ChatSpace> {
    const hit = this.spaces.get(name);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.space;
    const space = await this.call<ChatSpace>(auth, 'Chat', 'GET', `${CHAT}/${name}`);
    this.spaces.set(name, { space, at: Date.now() });
    return space;
  }

  async listSpaces(auth: Auth): Promise<ChatSpace[]> {
    const out = await this.call<{ spaces?: ChatSpace[] }>(
      auth,
      'Chat',
      'GET',
      `${CHAT}/spaces?pageSize=100`,
    );
    return out.spaces ?? [];
  }

  /**
   * Post a message as the employee. `requestId` makes it exactly once: posting again with
   * the same id returns the message already created instead of a second copy.
   */
  createMessage(
    auth: Auth,
    space: string,
    input: { text: string; threadName?: string | null; requestId: string },
  ): Promise<ChatMessage> {
    const params = new URLSearchParams({ requestId: input.requestId });
    if (input.threadName) params.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    return this.call(auth, 'Chat', 'POST', `${CHAT}/${space}/messages?${params.toString()}`, {
      text: input.text,
      ...(input.threadName ? { thread: { name: input.threadName } } : {}),
    });
  }

  // ── People (directory) ────────────────────────────────────────────────────────────

  /** Name and work email of a Chat user (`users/123`), cached for an hour. */
  async person(auth: Auth, chatUser: string): Promise<Person> {
    const id = chatUser.replace(/^users\//, '');
    const hit = this.people.get(id);
    if (hit && Date.now() - hit.at < 60 * 60_000) return hit.person;
    const p = await this.call<{
      names?: { displayName?: string }[];
      emailAddresses?: { value?: string }[];
    }>(
      auth,
      'People',
      'GET',
      `${PEOPLE}/people/${encodeURIComponent(id)}?personFields=names,emailAddresses&sources=READ_SOURCE_TYPE_PROFILE&sources=READ_SOURCE_TYPE_DOMAIN_CONTACT`,
    );
    const person = {
      name: p.names?.[0]?.displayName ?? null,
      email: p.emailAddresses?.[0]?.value?.toLowerCase() ?? null,
    };
    this.people.set(id, { person, at: Date.now() });
    return person;
  }

  // ── Workspace Events ──────────────────────────────────────────────────────────────

  async findSubscription(
    auth: Auth,
    target: string,
    eventType: string,
  ): Promise<WorkspaceSubscription | null> {
    const filter = `event_types:"${eventType}" AND target_resource="${target}"`;
    const out = await this.call<{ subscriptions?: WorkspaceSubscription[] }>(
      auth,
      'Workspace Events',
      'GET',
      `${EVENTS}/subscriptions?filter=${encodeURIComponent(filter)}`,
    );
    return out.subscriptions?.find((s) => s.state !== 'DELETED') ?? null;
  }

  /** Create a subscription; Google answers with an operation, polled until it is done. */
  async createSubscription(
    auth: Auth,
    input: { target: string; eventTypes: string[]; topic: string },
  ): Promise<WorkspaceSubscription> {
    let op = await this.call<{
      name: string;
      done?: boolean;
      response?: WorkspaceSubscription;
      error?: { message?: string };
    }>(auth, 'Workspace Events', 'POST', `${EVENTS}/subscriptions`, {
      targetResource: input.target,
      eventTypes: input.eventTypes,
      notificationEndpoint: { pubsubTopic: input.topic },
      payloadOptions: { includeResource: false },
    });
    for (let i = 0; !op.done && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      op = await this.call(auth, 'Workspace Events', 'GET', `${EVENTS}/${op.name}`);
    }
    if (op.error)
      throw new GoogleApiError(
        'bad_request',
        `Workspace Events: ${op.error.message ?? 'create failed'}`,
      );
    if (!op.done || !op.response)
      throw new GoogleApiError('unavailable', 'Workspace Events: subscription still being created');
    return op.response;
  }

  /** Extend to the longest allowed lifetime (ttl 0 = maximum). */
  renewSubscription(auth: Auth, name: string): Promise<unknown> {
    return this.call(auth, 'Workspace Events', 'PATCH', `${EVENTS}/${name}?updateMask=ttl`, {
      ttl: '0s',
    });
  }

  reactivateSubscription(auth: Auth, name: string): Promise<unknown> {
    return this.call(auth, 'Workspace Events', 'POST', `${EVENTS}/${name}:reactivate`, {});
  }

  getSubscription(auth: Auth, name: string): Promise<WorkspaceSubscription> {
    return this.call(auth, 'Workspace Events', 'GET', `${EVENTS}/${name}`);
  }

  // ── Pub/Sub ───────────────────────────────────────────────────────────────────────

  /** Wait for up to `max` events on the subscription (Pub/Sub holds the call open briefly). */
  async pull(auth: Auth, subscription: string, max: number): Promise<PulledMessage[]> {
    const out = await this.call<{ receivedMessages?: PulledMessage[] }>(
      auth,
      'Pub/Sub',
      'POST',
      `${PUBSUB}/${subscription}:pull`,
      { maxMessages: max },
      40_000,
    );
    return out.receivedMessages ?? [];
  }

  async ack(auth: Auth, subscription: string, ackIds: string[]): Promise<void> {
    if (ackIds.length === 0) return;
    await this.call(auth, 'Pub/Sub', 'POST', `${PUBSUB}/${subscription}:acknowledge`, { ackIds });
  }

  // ── Gmail ─────────────────────────────────────────────────────────────────────────

  gmailProfile(auth: Auth): Promise<{ emailAddress: string; historyId: string }> {
    return this.call(auth, 'Gmail', 'GET', `${GMAIL}/profile`);
  }

  /**
   * Ask Gmail to publish inbox changes to the topic. Calling it again renews the watch;
   * it lasts 7 days. Returns the history id the watch starts from.
   */
  gmailWatch(auth: Auth, topic: string): Promise<{ historyId: string; expiration: string }> {
    return this.call(auth, 'Gmail', 'POST', `${GMAIL}/watch`, {
      topicName: topic,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    });
  }

  /** Messages added to the inbox since a history id. Not found: the id is too old. */
  gmailHistory(auth: Auth, startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
      maxResults: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    return this.call(auth, 'Gmail', 'GET', `${GMAIL}/history?${params.toString()}`);
  }

  /**
   * Inbox message ids matching a Gmail search, newest first: recent mail when the history
   * id is too old, or mail since the account was linked.
   */
  async gmailSearchInbox(
    auth: Auth,
    query: string,
    max: number,
  ): Promise<{ id: string; threadId: string }[]> {
    const params = new URLSearchParams({ q: `in:inbox ${query}`, maxResults: String(max) });
    const out = await this.call<{ messages?: { id: string; threadId: string }[] }>(
      auth,
      'Gmail',
      'GET',
      `${GMAIL}/messages?${params.toString()}`,
    );
    return out.messages ?? [];
  }

  gmailMessage(auth: Auth, id: string): Promise<GmailMessage> {
    return this.call(
      auth,
      'Gmail',
      'GET',
      `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`,
    );
  }

  /** The thread's messages with only the given headers, for spotting a reply already sent. */
  async gmailThreadHeaders(auth: Auth, threadId: string, header: string): Promise<GmailMessage[]> {
    const params = new URLSearchParams({ format: 'metadata', metadataHeaders: header });
    const out = await this.call<{ messages?: GmailMessage[] }>(
      auth,
      'Gmail',
      'GET',
      `${GMAIL}/threads/${encodeURIComponent(threadId)}?${params.toString()}`,
    );
    return out.messages ?? [];
  }

  /** Send a raw RFC 5322 message (base64url) as the employee, in a thread. */
  gmailSend(
    auth: Auth,
    raw: string,
    threadId: string | null,
  ): Promise<{ id: string; threadId: string }> {
    return this.call(auth, 'Gmail', 'POST', `${GMAIL}/messages/send`, {
      raw,
      ...(threadId ? { threadId } : {}),
    });
  }

  log(): Logger {
    return this.logger;
  }
}
