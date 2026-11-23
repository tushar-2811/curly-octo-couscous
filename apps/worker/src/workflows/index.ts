/**
 * Workflow definitions. This file runs inside Temporal's deterministic sandbox: no I/O,
 * no Node APIs, no imports from our packages. All side effects happen in activities.
 */
import { log, proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../activities';

const { ping } = proxyActivities<Activities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3 },
});

/** End-to-end check that the worker, Temporal and activities are wired up. */
export async function pingWorkflow(message: string): Promise<string> {
  log.info('ping workflow started', { message });
  const reply = await ping(message);
  log.info('ping workflow completed', { reply });
  return reply;
}
