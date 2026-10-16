import type { ReactNode } from 'react';
import { requireVerifiedWebSession } from '../../server/require-web-session';

export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  await requireVerifiedWebSession();
  return children;
}
