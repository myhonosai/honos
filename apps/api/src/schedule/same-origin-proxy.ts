/**
 * The HON web app reaches Nest through its same-origin Next.js rewrite (`/api/v1/*`). Next's proxy
 * always sets `X-Forwarded-Host` to the Host the browser used, replacing any client-supplied value.
 * The header is accepted only when it names the configured public origin exactly; nothing reads it
 * for identity, tenant or authorization decisions. Every other forwarding header stays refused.
 */
export function forwardedHostMatchesPublicOrigin(value: unknown, publicOrigin: string): boolean {
  return value === undefined || (typeof value === 'string' && value === new URL(publicOrigin).host);
}
