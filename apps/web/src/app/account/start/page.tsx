import React from 'react';
import { HonOsStart } from '../../../components/hon-os-start/workbench';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Start your school', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
/** Identity continuity only: the subject keys a fresh private component per session. The API decides everything else. */
export default async function Page(): Promise<React.ReactElement> {
  const identity = await requireVerifiedWebSession();
  return <HonOsStart key={identity.viewKey} sessionSubject={identity.externalSubject} />;
}
