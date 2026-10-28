// Sends a minimal browser error report: error name, Next.js digest and page path only.
// Never the message, stack, URL query, form values or storage, which can hold personal data.
export function reportClientError(error: { name?: unknown; digest?: unknown }, kind: 'render' | 'unhandled' = 'render'): void {
  try {
    const body = JSON.stringify({
      kind,
      name: typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error',
      ...(typeof error.digest === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.digest) ? { digest: error.digest } : {}),
      path: window.location.pathname.slice(0, 256),
    });
    if (navigator.sendBeacon?.('/api/client-errors', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/client-errors', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  } catch {
    // Reporting must never cause a second failure.
  }
}
