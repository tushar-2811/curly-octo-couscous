import type { Logger } from '@aiw/logger';

/** Activities get their dependencies injected, so tests can pass fakes. */
export function createActivities(deps: { logger: Logger }) {
  return {
    async ping(message: string): Promise<string> {
      deps.logger.info({ message }, 'ping activity');
      return `pong: ${message}`;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
