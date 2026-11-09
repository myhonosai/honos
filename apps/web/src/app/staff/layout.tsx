import React from 'react';
import type { ReactNode } from 'react';
import { SchoolShell } from '../../components/school-shell/shell';
import { requireVerifiedWebSession } from '../../server/require-web-session';

export const dynamic = 'force-dynamic';

/**
 * Identity gate for staff browser routes, then the shared school shell. The shell
 * receives identity continuity only; each page and API authorizes its own school.
 */
export default async function StaffLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  const identity = await requireVerifiedWebSession();
  return <SchoolShell key={identity.viewKey} sessionSubject={identity.externalSubject}>{children}</SchoolShell>;
}
