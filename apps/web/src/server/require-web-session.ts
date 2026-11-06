import 'server-only';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';

/** Identity continuity only: the verified subject and an opaque per-session React key. Never authority. */
export type VerifiedWebIdentity = Readonly<{ externalSubject: string; viewKey: string }>;

/**
 * Browser-route identity gate only. Domain APIs must still resolve their own
 * current principal, control-plane/school scope, permissions, and entitlements.
 */
export async function requireVerifiedWebSession(): Promise<VerifiedWebIdentity> {
  let identity: VerifiedWebIdentity | null = null;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) {
      const session = verifySession(token, sessionConfig());
      identity = { externalSubject: session.externalSubject, viewKey: createHash('sha256').update(token).digest('hex') };
    }
  } catch {
    // Fail closed: pages remain inaccessible when session verification is unavailable or invalid.
  }
  if (!identity) redirect('/auth/login');
  return identity;
}
