import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';

/**
 * Browser-route identity gate only. Domain APIs must still resolve their own
 * current principal, control-plane/school scope, permissions, and entitlements.
 */
export async function requireVerifiedWebSession(): Promise<void> {
  let authenticated = false;
  try {
    const token = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    if (token) {
      verifySession(token, sessionConfig());
      authenticated = true;
    }
  } catch {
    // Fail closed: pages remain inaccessible when session verification is unavailable or invalid.
  }
  if (!authenticated) redirect('/auth/login');
}
