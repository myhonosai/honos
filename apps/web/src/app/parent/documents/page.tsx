import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { DocumentAcknowledgementDesk } from '../../../components/document-workbench';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'HON | Parent Documents',
  description: 'Verified family document review and acknowledgement.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default async function ParentDocumentsPage() {
  let authenticated = false;
  try {
    const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE);
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed, including duplicate, malformed, expired, or unconfigured cookies */ }
  if (!authenticated) redirect('/auth/login');
  return <DocumentAcknowledgementDesk parent />;
}
