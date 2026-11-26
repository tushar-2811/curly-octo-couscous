import { Writable } from 'node:stream';
import { createDb, createMigrator } from '@aiw/db';
import type { StructuredLlm, StructuredRequest } from '@aiw/engine';
import { createLogger } from '@aiw/logger';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE, SessionCodec } from './session';

const url = process.env.TEST_DATABASE_URL;

class FakeLlm implements StructuredLlm {
  readonly model = 'fake-model';
  readonly requests: StructuredRequest[] = [];
  async generate(request: StructuredRequest) {
    this.requests.push(request);
    if (request.name === 'chat_reply') {
      return {
        text: JSON.stringify({ reply: 'I will check WEB-1.', answered: 'no', used_sources: [] }),
        model: this.model,
        inputTokens: 80,
        outputTokens: 12,
        latencyMs: 4,
      };
    }
    return {
      text: JSON.stringify({
        intent: 'question',
        addressed_to_me: 'direct_message',
        should_respond: true,
        urgency: 'later',
        needs: ['jira'],
        references: { jira_keys: ['WEB-1'], repos: [], people: [], urls: [] },
        summary: 'Asks about WEB-1',
        confidence: 0.9,
        reason: 'Direct question',
      }),
      model: this.model,
      inputTokens: 50,
      outputTokens: 10,
      latencyMs: 3,
    };
  }
}

describe.skipIf(!url)('inbox API', () => {
  const logger = createLogger({
    service: 'web',
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger });
  const run = Date.now().toString(36);
  const domain = `inbox-${run}.test`;
  const llm = new FakeLlm();
  let app: FastifyInstance;
  let admin = '';
  let employeeId = '';

  const cookieFrom = (res: LightMyRequestResponse) =>
    `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  const call = (cookie: string, method: 'GET' | 'POST', path: string, payload?: object) =>
    app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
  const signIn = async (email: string, name: string) =>
    cookieFrom(
      await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { email, name } }),
    );

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    app = await buildApp({
      logger,
      meta: { service: 'web', version: 't', env: 'test' },
      readinessChecks: {},
      auth: {
        db,
        codec: new SessionCodec('s'.repeat(32), 1),
        secureCookies: false,
        devLogin: true,
        engine: { llm, allowTestMessages: true },
      },
    });
    const created = await call(await signIn(`owner@${domain}`, 'Owner'), 'POST', '/v1/orgs', {
      name: 'Inbox Co',
      domain,
    });
    admin = cookieFrom(created);
    const hired = await call(admin, 'POST', '/v1/employees', {
      display_name: 'Nova',
      role_key: 'frontend_engineer',
      email: `nova@${domain}`,
    });
    employeeId = hired.json().employee.id;
    await call(admin, 'POST', '/v1/members', {
      display_name: 'Mia',
      email: `mia@${domain}`,
      title: null,
      role: 'member',
      org_unit_id: null,
      manager_id: null,
    });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('classifies a test message and lists it with its decision', async () => {
    const res = await call(admin, 'POST', `/v1/employees/${employeeId}/inbox/test`, {
      body: 'What is the status of WEB-1?',
      space_type: 'direct',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().decision).toMatchObject({
      action: 'reply',
      needs: ['jira'],
      model: 'fake-model',
    });
    expect(llm.requests.map((r) => r.name)).toEqual(['classification', 'chat_reply']);
    expect(res.json().replies.map((r: { kind: string }) => r.kind)).toEqual(['ack', 'reply']);

    const inbox = (await call(admin, 'GET', `/v1/employees/${employeeId}/inbox`)).json();
    expect(inbox.classifier).toEqual({ model: 'fake-model' });
    expect(inbox.entries[0].message).toMatchObject({
      body: 'What is the status of WEB-1?',
      sender: { name: 'Owner' },
      status: 'decided',
    });
    expect(inbox.entries[0].decision.facts.direct_message).toBe(true);
    expect(inbox.entries[0].replies[1]).toMatchObject({
      body: 'I will check WEB-1.',
      status: 'draft',
      answered: 'no',
    });
  });

  it('validates test messages', async () => {
    const res = await call(admin, 'POST', `/v1/employees/${employeeId}/inbox/test`, { body: '  ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe('body');
  });

  it('is for admins only', async () => {
    const mia = await signIn(`mia@${domain}`, 'Mia');
    expect((await call(mia, 'GET', `/v1/employees/${employeeId}/inbox`)).statusCode).toBe(403);
    const res = await call(mia, 'POST', `/v1/employees/${employeeId}/inbox/test`, { body: 'hi' });
    expect(res.statusCode).toBe(403);
  });
});
