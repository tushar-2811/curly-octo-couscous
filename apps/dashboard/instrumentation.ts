/**
 * Next.js server instrumentation. onRequestError logs every server-side rendering or
 * route error as one JSON line, including the digest the browser shows as "Error ID".
 */
export async function register(): Promise<void> {
  // Reserved for OpenTelemetry setup when traces are exported.
}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  const err = error as Error & { digest?: string };
  console.error(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      service: 'dashboard',
      env: process.env.APP_ENV ?? 'local',
      msg: 'server render error',
      digest: err.digest,
      path: request.path,
      method: request.method,
      route: context.routePath,
      route_type: context.routeType,
      err: { type: err.name, message: err.message, stack: err.stack },
    }),
  );
}
