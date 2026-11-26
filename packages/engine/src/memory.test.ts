import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { addPerson, hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from './embeddings';
import {
  embedPending,
  embedQuery,
  rememberMessage,
  searchMemory,
  wordsQuery,
  type Readers,
} from './memory';
import { recordInbound, type InboundInput } from './messages';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

/** Bag of words hashed into 1024 dimensions: shared words mean similar vectors. */
class FakeEmbedder implements Embedder {
  readonly model = 'fake-embed';
  readonly dimensions = 1024;
  calls = 0;
  fail = false;
  async embed(texts: string[]) {
    this.calls++;
    if (this.fail) throw new EmbeddingError('unavailable', 'down');
    const vectors = texts.map((t) => {
      const v = new Array<number>(1024).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        v[createHash('sha1').update(w).digest().readUInt16BE(0) % 1024]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, tokens: 10, latencyMs: 1 };
  }
}

describe('wordsQuery', () => {
  it('ORs safe words and drops punctuation', () => {
    expect(wordsQuery("What's the status of WEB-12?")).toBe('what | the | status | of | web | 12');
    expect(wordsQuery("'); drop table x; --")).toBe('drop | table');
    expect(wordsQuery('!!')).toBeNull();
  });
});

describe.skipIf(!url)('memory', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `memory-${run}.test`;
  const embedder = new FakeEmbedder();
  const deps = { db, embedder, logger: silent };
  let admin: Member;
  let nova: Member;
  let mia: Member;
  let raj: Member;
  let ctx: ActorContext;
  let n = 0;
  const ids: Record<string, string> = {};
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  async function say(key: string, from: Member, body: string, over: Partial<InboundInput> = {}) {
    const { message } = await inOrg((trx) =>
      recordInbound(trx, {
        orgId: ctx.orgId,
        employeeId: nova.id,
        source: 'simulated',
        externalId: `m-${run}-${++n}`,
        threadKey: null,
        spaceName: null,
        spaceType: 'direct',
        senderEmail: from.email,
        senderName: from.display_name,
        subject: null,
        body,
        mentions: [],
        to: [],
        cc: [],
        sentAt: new Date(),
        ...over,
      }),
    );
    ids[key] = message.id;
    return rememberMessage(deps, ctx.orgId, message);
  }

  const find = async (readers: Readers, text: string) => {
    const vector = await embedQuery(deps, text);
    const hits = await inOrg((trx) =>
      searchMemory(trx, { employeeId: nova.id, readers, text, vector }),
    );
    return hits;
  };
  const sources = (hits: { source_id: string }[]) =>
    Object.entries(ids)
      .filter(([, id]) => hits.some((h) => h.source_id === id))
      .map(([k]) => k);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:memory-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Memory Co',
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

    await say('miaSecret', mia, 'The staging password rotation happens every Friday at noon');
    await say('rajEng', raj, 'WEB-12 is blocked on the payments API review', {
      spaceType: 'space',
      spaceName: 'spaces/eng',
    });
    await say('miaDesign', mia, 'The new logo ships next sprint', {
      spaceType: 'space',
      spaceName: 'spaces/design',
    });
  });
  afterAll(() => db.destroy());

  it('saves each message once, with an embedding', async () => {
    const again = await inOrg((trx) =>
      trx
        .selectFrom('conversations.inbound_messages')
        .selectAll()
        .where('id', '=', ids.miaSecret!)
        .executeTakeFirstOrThrow(),
    );
    expect(await rememberMessage(deps, ctx.orgId, again)).toBeNull();
    const items = await inOrg((trx) =>
      trx
        .selectFrom('knowledge.memory_items')
        .select(['content', 'embedding_model', 'scope', 'audience'])
        .where('source_id', '=', ids.miaSecret!)
        .execute(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ embedding_model: 'fake-embed', scope: 'direct' });
    expect(items[0]!.audience).toEqual(expect.arrayContaining([mia.id, nova.id]));
    expect(items[0]!.content).toMatch(/^Mia \(direct message, \d{4}-\d{2}-\d{2}\): The staging/);
  });

  it('finds by meaning and words, but only what the readers could see', async () => {
    const forMia = await find({ kind: 'direct', memberIds: [mia.id] }, 'when is password rotation');
    expect(sources(forMia)).toContain('miaSecret');
    expect(forMia[0]!.matched_by).toEqual(expect.arrayContaining(['meaning', 'words']));

    // Raj never saw Mia's direct message.
    expect(
      sources(await find({ kind: 'direct', memberIds: [raj.id] }, 'password rotation')),
    ).not.toContain('miaSecret');
    // Raj is in the eng space but not the design space.
    expect(
      sources(await find({ kind: 'direct', memberIds: [raj.id] }, 'WEB-12 blocked')),
    ).toContain('rajEng');
    expect(sources(await find({ kind: 'direct', memberIds: [raj.id] }, 'new logo'))).not.toContain(
      'miaDesign',
    );
    // A reply in a space can only use that space.
    const inEng = { kind: 'space' as const, spaceName: 'spaces/eng' };
    expect(sources(await find(inEng, 'WEB-12 payments'))).toContain('rajEng');
    expect(sources(await find(inEng, 'password rotation logo'))).toEqual([]);
    // Every reader must be able to see it.
    expect(
      sources(await find({ kind: 'direct', memberIds: [mia.id, raj.id] }, 'password rotation')),
    ).not.toContain('miaSecret');
  });

  it('keeps messages when embeddings fail, and embeds them later', async () => {
    embedder.fail = true;
    const item = await say('offline', raj, 'Deploy freeze starts on the 20th');
    expect(item?.embedding).toBeNull();
    // Still found by words.
    expect(sources(await find({ kind: 'direct', memberIds: [raj.id] }, 'deploy freeze'))).toContain(
      'offline',
    );
    embedder.fail = false;
    expect(await embedPending(deps, ctx.orgId)).toBe(1);
    expect(await embedPending(deps, ctx.orgId)).toBe(0);
  });
});
