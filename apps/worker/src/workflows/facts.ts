/**
 * FactsWorkflow: read one quiet conversation and save the facts in it. Started by the
 * worker's sweep with id `facts-<employee>-<conversation hash>-<last message id>`, so each
 * batch of new messages is read once.
 */
import { log, proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../activities';

const { extractFacts } = proxyActivities<Activities>({
  startToCloseTimeout: '3 minutes',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['NoModel'],
  },
});

export interface FactsInput {
  orgId: string;
  employeeId: string;
  conversationKey: string;
}

export async function factsWorkflow(
  input: FactsInput,
): Promise<{ read: number; added: number; superseded: number }> {
  const result = await extractFacts(input);
  log.info('facts extracted', { employee_id: input.employeeId, ...result });
  return result;
}
