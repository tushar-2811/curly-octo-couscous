/** Start pingWorkflow and print the result: `pnpm --filter @aiw/worker ping`. */
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { loadWorkerConfig } from '../src/config';

const config = loadWorkerConfig();
const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
const workflowId = `ping-${randomUUID()}`;
const result = await client.workflow.execute('pingWorkflow', {
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  workflowId,
  args: ['hello'],
});
console.log(`${workflowId} -> ${String(result)}`);
await connection.close();
