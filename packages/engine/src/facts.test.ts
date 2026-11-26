import { Writable } from 'node:stream';
import { createDb, createMigrator, sql, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { addPerson, hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversationsToDigest,
  extractConversationFacts,
  listFacts,
  pendingConversations,
} from './facts-extract';
import { LlmError, type StructuredLlm, type StructuredRequest } from './llm';
import { rememberMessage, searchMemory } from './memory';
import { recordInbound, type InboundInput } from './messages';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

class FakeLlm implements StructuredLlm {
  readonly model = 'fake';
  readonly requests: StructuredRequest[] = [];
  next: unknown[] = [];
  async generate(request: StructuredRequest) {
    this.requests.push(request);
    const out = this.next.shift();
    if (out instanceof Error) throw out;
    return {
      text: JSON.stringify(out),
      model: 'fake',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
    };
  }
}

const fact = (over: Record<string, unknown>) => ({
  kind: 'decision',
  content: 'A fact',
  source_messages: [1],
  confidence: 0.9,
  supersedes: [],
  ...over,
});

describe.skipIf(!url)('fact extraction', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `facts-${run}.test`;
  const llm = new FakeLlm();
  const deps = { db, llm, embedder: null, logger: silent };
  let admin: Member;
  let nova: Member;
  let mia: Member;
  let raj: Member;
  let ctx: ActorContext;
  let n = 0;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  async function say(from: Member, body: string, over: Partial<InboundInput> = {}) {
    const { message } = await inOrg((trx) =>
      recordInbound(trx, {
        orgId: ctx.orgId,
        employeeId: nova.id,
        source: 'simulated',
        externalId: `f-${run}-${++n}`,
        threadKey: null,
        spaceName: 'spaces/release',
        spaceType: 'space',
        senderEmail: from.email,
        senderName: from.display_name,
        subject: null,
        body,
        mentions: [],
        to: [],
        cc: [],
        sentAt: new Date('2026-11-26T10:00:00Z'),
        ...over,
      }),
    );
    await rememberMessage({ db, embedder: null, logger: silent }, ctx.orgId, message);
    return message;
  }

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:facts-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Facts Co',
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
    const person = (name: string) =>
      inOrg((trx) =>
        addPerson(trx, ctx, admin, {
          displayName: name,
          email: `${name.toLowerCase()}@${domain}`,
          title: null,
          role: 'member',
          orgUnitId: null,
          managerId: null,
        }),
      );
    mia = await person('Mia');
    raj = await person('Raj');
  });
  afterAll(() => db.destroy());

  it('saves standalone facts with their source messages, once', async () => {
    const m1 = await say(mia, 'Release moves to Thursday because the payments review is open');
    await say(raj, 'ok, I will update PF-12 with the new date by tomorrow');
    const conversation = m1.conversation_key;
    expect(conversation).toBe('space:spaces/release');
    expect(await inOrg((trx) => pendingConversations(trx, nova.id))).toEqual([conversation]);

    llm.next.push({
      facts: [
        fact({
          content: 'The release moved to 3 December 2026 because the payments review is open.',
        }),
        fact({
          kind: 'action_item',
          content: 'Raj will update PF-12 with the new release date by 27 November 2026.',
          source_messages: [2, 7],
        }),
        fact({ content: 'Invented fact with no real source', source_messages: [9] }),
      ],
    });
    const result = await extractConversationFacts(deps, ctx.orgId, nova.id, conversation);
    expect(result).toMatchObject({ read: 2, superseded: 0 });
    expect(result.added.map((a) => a.kind)).toEqual(['decision', 'action_item']);
    expect(result.added[0]).toMatchObject({ scope: 'space', space_name: 'spaces/release' });
    expect(llm.requests[0]!.input).toContain('1. Mia on 2026-11-26: Release moves to Thursday');

    const listed = await inOrg((trx) => listFacts(trx, nova.id, { limit: 10 }));
    expect(
      listed.entries.find((e) => e.item.kind === 'action_item')!.sources.map((s) => s.sender),
    ).toEqual(['Raj']);
    // Nothing new: no model call.
    const again = await extractConversationFacts(deps, ctx.orgId, nova.id, conversation);
    expect(again).toMatchObject({ read: 0, call: null });
    expect(llm.requests).toHaveLength(1);
    expect(await inOrg((trx) => pendingConversations(trx, nova.id))).toEqual([]);
  });

  it('replaces facts that changed, and keeps the earlier messages as context', async () => {
    await say(mia, 'Update: release is back on Wednesday, the review closed');
    llm.next.push({
      facts: [
        fact({
          content: 'The release is back on 2 December 2026 because the payments review closed.',
          supersedes: [1],
        }),
      ],
    });
    const result = await extractConversationFacts(deps, ctx.orgId, nova.id, 'space:spaces/release');
    expect(result.superseded).toBe(1);
    const prompt = llm.requests.at(-1)!.input;
    expect(prompt).toContain('K1. [decision] The release moved to 3 December 2026');
    expect(prompt).toContain('<earlier>');
    const active = await inOrg((trx) => listFacts(trx, nova.id, { limit: 10 }));
    expect(active.entries.map((e) => e.item.content)).not.toContain(
      'The release moved to 3 December 2026 because the payments review is open.',
    );
    const all = await inOrg((trx) =>
      listFacts(trx, nova.id, { limit: 10, includeSuperseded: true }),
    );
    expect(all.entries.some((e) => e.item.status === 'superseded')).toBe(true);
  });

  it('keeps facts from a direct message private to its people', async () => {
    const dm = await say(mia, 'My laptop password manager vault is called Orion', {
      spaceType: 'direct',
      spaceName: null,
    });
    llm.next.push({
      facts: [fact({ kind: 'technical_fact', content: "Mia's vault is called Orion." })],
    });
    await extractConversationFacts(deps, ctx.orgId, nova.id, dm.conversation_key);
    const find = (memberIds: string[]) =>
      inOrg((trx) =>
        searchMemory(trx, {
          employeeId: nova.id,
          readers: { kind: 'direct', memberIds },
          text: 'vault Orion',
          vector: null,
        }),
      );
    expect((await find([mia.id])).some((h) => h.kind === 'technical_fact')).toBe(true);
    expect((await find([raj.id])).some((h) => h.kind === 'technical_fact')).toBe(false);
  });

  it('reads the same messages again after a model failure', async () => {
    const m = await say(raj, 'QA sign-off is needed before every release', {
      spaceName: 'spaces/qa',
    });
    llm.next.push(new LlmError('unavailable', 'down'));
    await expect(
      extractConversationFacts(deps, ctx.orgId, nova.id, m.conversation_key),
    ).rejects.toThrow(LlmError);
    llm.next.push({
      facts: [fact({ kind: 'requirement', content: 'Every release needs QA sign-off.' })],
    });
    const retried = await extractConversationFacts(deps, ctx.orgId, nova.id, m.conversation_key);
    expect(retried).toMatchObject({ read: 1 });
    expect(retried.added).toHaveLength(1);
  });

  it('finds quiet conversations for the worker sweep', async () => {
    const m = await say(mia, 'Design review moved to Monday', { spaceName: 'spaces/design' });
    expect(
      (await conversationsToDigest(db, 600, 200)).some(
        (c) => c.conversation_key === m.conversation_key,
      ),
    ).toBe(false);
    await db
      .updateTable('conversations.inbound_messages')
      .set({ received_at: sql<Date>`now() - interval '20 minutes'` })
      .where('id', '=', m.id)
      .execute();
    const ready = await conversationsToDigest(db, 600, 200);
    expect(ready.find((c) => c.conversation_key === m.conversation_key)).toMatchObject({
      employee_id: nova.id,
      last_message_id: m.id,
    });
  });
});
