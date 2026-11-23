import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { addLogContext, withLogContext } from './context';
import { createLogger } from './logger';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const logger = createLogger({ service: 'test', version: '1.2.3', env: 'test', destination });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes JSON with service fields and a text level', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello');
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'hello',
      service: 'test',
      version: '1.2.3',
      env: 'test',
    });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('adds the current log context to every line', () => {
    const { logger, lines } = captureLogger();
    withLogContext({ request_id: 'req-1', org_id: 'org-1' }, () => {
      addLogContext({ task_id: 'task-9' });
      logger.info('inside');
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({ request_id: 'req-1', org_id: 'org-1', task_id: 'task-9' });
    expect(lines[1]).not.toHaveProperty('request_id');
  });

  it('redacts secrets', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        token: 'abc',
        credentials: { refreshToken: 'xyz' },
        req: { headers: { authorization: 'Bearer q' } },
      },
      'auth',
    );
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('abc');
    expect(line).not.toContain('xyz');
    expect(line).not.toContain('Bearer q');
    expect(line).toContain('[REDACTED]');
  });

  it('serializes errors with stack and cause', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('outer', { cause: new Error('inner') });
    logger.error({ err }, 'failed');
    const logged = lines[0]?.err as Record<string, unknown>;
    expect(logged.message).toContain('outer');
    expect(String(logged.stack)).toContain('Error: outer');
    expect(JSON.stringify(logged)).toContain('inner');
  });
});
