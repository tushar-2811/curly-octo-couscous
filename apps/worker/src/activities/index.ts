import { withTenant, type Database, type Kysely } from '@aiw/db';
import type { Logger } from '@aiw/logger';
import { continueOnboarding } from '@aiw/workforce';

export interface ActivityDeps {
  logger: Logger;
  /** Absent in tests that only exercise ping. */
  db?: Kysely<Database>;
}

/** Activities get their dependencies injected, so tests can pass fakes. */
export function createActivities(deps: ActivityDeps) {
  const requireDb = () => {
    if (!deps.db) throw new Error('Database is not configured for this worker');
    return deps.db;
  };
  return {
    async ping(message: string): Promise<string> {
      deps.logger.info({ message }, 'ping activity');
      return `pong: ${message}`;
    },

    /**
     * Move a linked employee on to connecting its tools (identity_connected →
     * integrations_pending). Idempotent, so Temporal can retry it safely.
     */
    async continueOnboarding(input: { orgId: string; memberId: string }): Promise<string> {
      const state = await withTenant(requireDb(), input.orgId, (trx) =>
        continueOnboarding(
          trx,
          { orgId: input.orgId, actorMemberId: null, requestId: null },
          input.memberId,
        ),
      );
      deps.logger.info({ employee_id: input.memberId, state }, 'onboarding continued');
      return state;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
