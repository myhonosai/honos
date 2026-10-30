// Next.js server instrumentation hook: records server-rendering and route-handler failures as
// redacted JSON. The request URL's query string, headers, cookies and the exception message are never
// recorded: free text can carry student, family or medical details. The digest correlates the record
// with the support reference shown to the user.
export async function register(): Promise<void> {}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
): Promise<void> {
  const { emitWebTelemetry } = await import('./server/web-telemetry');
  const digest = typeof (error as { digest?: unknown })?.digest === 'string' ? (error as { digest: string }).digest : undefined;
  emitWebTelemetry('error', 'web.request_error', {
    route: context.routePath ?? request.path,
    method: request.method,
    ...(digest === undefined ? {} : { digest }),
    errorName: error instanceof Error ? error.name : typeof error,
    ...(context.routeType === undefined ? {} : { routeType: context.routeType }),
  });
}
