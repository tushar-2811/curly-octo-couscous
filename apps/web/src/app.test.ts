import { Writable } from 'node:stream';
import { createLogger } from '@aiw/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';

function setup(checks: Record<string, () => Promise<void>> = { database: async () => {} }) {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      callback();
    },
  });
  const logger = createLogger({ service: 'web', level: 'debug', destination });
  return {
    lines,
    appPromise: buildApp({
      logger,
      meta: { service: 'web', version: 't', env: 'test' },
      readinessChecks: checks,
    }),
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('web app', () => {
  it('answers liveness and echoes a safe request id', async () => {
    const { appPromise } = setup();
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'abc-123' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('replaces an unsafe request id', async () => {
    const { appPromise } = setup();
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({
      url: '/healthz',
      headers: { 'x-request-id': 'bad id <script>' },
    });
    expect(res.headers['x-request-id']).not.toBe('bad id <script>');
  });

  it('returns 503 problem when a dependency fails, and logs which one', async () => {
    const { appPromise, lines } = setup({
      database: async () => {
        throw new Error('connection refused');
      },
    });
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({ code: 'dependency_unavailable', checks: { database: 'failed' } });
    expect(body.request_id).toBeTruthy();
    expect(
      lines.some((l) => l.msg === 'readiness check failed' && l.dependency === 'database'),
    ).toBe(true);
  });

  it('returns a problem response for unknown routes', async () => {
    const { appPromise } = setup();
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('accepts client logs and writes them with request context', async () => {
    const { appPromise, lines } = setup();
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/client-logs',
      headers: { 'x-request-id': 'req-client-1' },
      payload: {
        events: [{ level: 'error', message: 'Render failed', route: '/org', digest: 'd1' }],
      },
    });
    expect(res.statusCode).toBe(202);
    const logged = lines.find((l) => l.msg === 'Render failed');
    expect(logged).toMatchObject({
      level: 'error',
      source: 'dashboard',
      request_id: 'req-client-1',
      digest: 'd1',
    });
  });

  it('rejects invalid client logs with field-level errors', async () => {
    const { appPromise } = setup();
    const app = await appPromise;
    close = () => app.close();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/client-logs',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
    expect(res.json().errors[0].path).toBe('events');
  });

  it('logs one completion line per request with status and duration', async () => {
    const { appPromise, lines } = setup();
    const app = await appPromise;
    close = () => app.close();
    await app.inject({ url: '/v1/meta' });
    const done = lines.find((l) => l.msg === 'request completed' && l.route === '/v1/meta');
    expect(done).toMatchObject({ level: 'info', status: 200, method: 'GET' });
    expect(typeof done?.duration_ms).toBe('number');
    expect(done?.request_id).toBeTruthy();
  });
});
