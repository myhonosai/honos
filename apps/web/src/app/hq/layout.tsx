import type { ReactNode } from 'react';
import { HqModernShell } from '../../components/hq-modern/shell';
import { requireVerifiedWebSession } from '../../server/require-web-session';

export const dynamic = 'force-dynamic';

/**
 * Identity gate for HQ browser routes. It intentionally derives no school,
 * family, staff, or control-plane authority; HQ APIs establish that separately.
 */
export default async function HqLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  await requireVerifiedWebSession();
  return <HqModernShell>{children}</HqModernShell>;
}
