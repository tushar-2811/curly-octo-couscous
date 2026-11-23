import { Writable } from 'node:stream';
import { createLogger } from '@aiw/logger';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { ActivityLoggingInterceptor } from './logging';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _e, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, logger: createLogger({ service: 'worker', level: 'debug', destination }) };
}

const input = { args: [], headers: {} };

describe('ActivityLoggingInterceptor', () => {
  it('logs completion with workflow and activity context', async () => {
    const { lines, logger } = capture();
    const env = new MockActivityEnvironment({ activityType: 'ping', attempt: 1 });
    const interceptor = new ActivityLoggingInterceptor(logger);
    await env.run(() => interceptor.execute(input, async () => 'ok'));
    const done = lines.find((l) => l.msg === 'activity completed');
    expect(done).toMatchObject({ activity: 'ping', attempt: 1 });
    expect(done).toHaveProperty('workflow_id');
    expect(typeof done?.duration_ms).toBe('number');
  });

  it('logs a failure as a warning while retries remain', async () => {
    const { lines, logger } = capture();
    const env = new MockActivityEnvironment({ activityType: 'ping', attempt: 1 });
    const interceptor = new ActivityLoggingInterceptor(logger);
    await expect(
      env.run(() =>
        interceptor.execute(input, async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    const failed = lines.find((l) => String(l.msg).startsWith('activity failed'));
    expect(failed).toMatchObject({ level: 'warn', will_retry: true });
  });
});
