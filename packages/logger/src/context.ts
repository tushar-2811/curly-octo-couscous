import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation fields carried through one unit of work: an HTTP request, a workflow
 * activity, a job. Every log line written inside `withLogContext` carries them, so a
 * single request or task can be followed across processes by filtering on one id.
 *
 * Field names are snake_case to match log queries and the database columns.
 */
export interface LogContext {
  request_id?: string;
  trace_id?: string;
  org_id?: string;
  member_id?: string;
  task_id?: string;
  execution_id?: string;
  workflow_id?: string;
  activity?: string;
  [key: string]: string | number | boolean | undefined;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `context` merged over the current context. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...stripUndefined(context) };
  return storage.run(merged, fn);
}

/**
 * Add fields to the current context in place, for values learned part-way through
 * a request (for example the org id after authentication). No-op outside a context.
 */
export function addLogContext(context: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, stripUndefined(context));
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

function stripUndefined(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as LogContext;
}
