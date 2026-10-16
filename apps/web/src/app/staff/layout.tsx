import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';

export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
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
  return children;
}
