import React from 'react';
import { requireVerifiedWebSession } from '../../../../../server/require-web-session';
import { A2pRegistrationAssistant } from '../../../../../components/a2p-registration/production-entry';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Business Texting Registration', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** Settings → Communications → Business Texting → A2P Registration. Not connected until the A2P backend exists. */
export default async function A2pRegistrationPage(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <A2pRegistrationAssistant />;
}
